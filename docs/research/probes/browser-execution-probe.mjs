import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve('.');
const file = resolve(root, 'apps/extension/src/background.ts');
const source = await readFile(file, 'utf8');
const bundled = await build({ stdin: { contents: source + '\nexport { dispatchBrowserWork, pollTasks, reserveBrowser, finishTask, claimAndOpen, browserLane, trackedTasks, trackedJobs, payloadForJob, queueDeepCollect, cancelDeepCollect, deepQueue };', sourcefile: file, resolveDir: resolve(root, 'apps/extension/src'), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'ReviewBg', platform: 'browser', target: 'chrome120', write: false });
const account = '000000000000000000000002';
const job = { id: 101, status: 'pending', xhsUserId: account, draft: { title: 'Offline fixture', content: 'Mock only', images: [] } };
function event() { return { listeners: [], addListener(fn) { this.listeners.push(fn); } }; }
function store(seed = {}) { const data = structuredClone(seed); return { data, async get(key) { if (typeof key === 'string') return { [key]: data[key] }; if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, data[k]])); return structuredClone(data); }, async set(value) { Object.assign(data, structuredClone(value)); }, async remove(key) { for (const k of Array.isArray(key) ? key : [key]) delete data[k]; } }; }
async function fixture({ tabs = [], jobs = [], tasks = [] } = {}) {
  const calls = [], created = [], removed = [], warnings = [], liveTabs = structuredClone(tabs); let nextId = 1000, debuggerAttachments = 0;
  const local = store({ auth: { apiBase: 'https://offline.invalid', token: 'fixture-only' } }), session = store({ swId: 'fixture-sw' });
  const chrome = { runtime: { getManifest: () => ({ version: '0.1.8', content_scripts: [] }), onMessage: event(), onInstalled: event(), onStartup: event() }, storage: { local, session, onChanged: event() }, alarms: { onAlarm: event(), get: async () => ({ name: 'already-present' }), create: async () => {} }, tabs: { onUpdated: event(), query: async () => structuredClone(liveTabs), create: async args => { const tab = { id: nextId++, ...args }; liveTabs.push(tab); created.push(tab); return tab; }, remove: async id => { removed.push(id); const i = liveTabs.findIndex(t => t.id === id); if (i >= 0) liveTabs.splice(i, 1); }, update: async (id, args) => Object.assign(liveTabs.find(t => t.id === id), args), sendMessage: async (_id, msg) => msg.type === 'GET_LOGIN_STATE' ? { ok: true, data: { loggedIn: true, userId: account, nickname: 'Fixture' } } : { ok: true } }, debugger: { attach: async () => { debuggerAttachments++; }, detach: async () => {}, sendCommand: async () => ({}) }, cookies: { get: async () => null } };
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname; calls.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
    let body;
    if (path === '/api/ext/publish/pending') body = { jobs };
    else if (path === '/api/ext/tasks/pending') body = { tasks };
    else if (path === '/api/ext/collection-tasks/claim') body = { claim: null };
    else if (/\/(claim|result)$/.test(path)) body = { ok: true };
    else if (path === '/api/ext/publish/101') body = { ...job, status: 'running' };
    else throw new Error('Unexpected offline path: ' + path);
    return { status: 200, ok: true, json: async () => structuredClone(body) };
  };
  const context = vm.createContext({ chrome, fetch, console: { warn: (...x) => warnings.push(x.map(String).join(' ')) }, URL, setTimeout, clearTimeout, setInterval, clearInterval, btoa: x => Buffer.from(x, 'binary').toString('base64') });
  vm.runInContext(bundled.outputFiles[0].text, context);
  await new Promise(resolve => setTimeout(resolve, 0));
  return { bg: context.ReviewBg, chrome, calls, created, removed, liveTabs, warnings, get debuggerAttachments() { return debuggerAttachments; } };
}

const evidence = [];
{
  const f = await fixture({ tabs: [{ id: 6, url: 'https://www.xiaohongshu.com/explore' }] }); await f.bg.claimAndOpen(job); let response;
  f.chrome.runtime.onMessage.listeners[0]({ type: 'TRUSTED_CLICK', x: 0, y: 0, selectors: ['xhs-publish-btn'] }, { tab: f.created[0] }, r => { response = r; });
  assert.equal(response.data.ok, false); assert.equal(f.debuggerAttachments, 0); assert.equal(f.bg.browserLane.busy, true);
  evidence.push({ name: 'publish rejects its own trusted click', response, debuggerAttachments: f.debuggerAttachments, laneBusy: f.bg.browserLane.busy });
}
{
  const f = await fixture({ tabs: [{ id: 7, url: 'https://www.xiaohongshu.com/search_result?keyword=fixture&__v2m_collect_task=5&__v2m_lease=old' }], jobs: [job] });
  await f.bg.dispatchBrowserWork(); await f.bg.dispatchBrowserWork();
  assert.equal(f.created.length, 0); assert.equal(f.removed.length, 0); assert.equal(f.calls.filter(c => c.path === '/api/ext/publish/101/claim').length, 0);
  evidence.push({ name: 'orphan keyword tab + pending publish deadlock', dispatches: 2, created: f.created.length, removed: f.removed.length, publishClaims: f.calls.filter(c => c.path === '/api/ext/publish/101/claim').length, warnings: f.warnings });
}
{
  const task = { id: 86, type: 'metrics', payload: { noteId: '000000000000000000000013', noteUrl: 'https://www.xiaohongshu.com/explore/000000000000000000000013' } };
  const f = await fixture({ tabs: [{ id: 8, url: 'https://www.xiaohongshu.com/explore/000000000000000000000013?__v2m_task=86' }], tasks: [task] });
  await f.bg.pollTasks(); const tracked = f.bg.trackedTasks.get(86); assert.ok(tracked); assert.equal(f.created.length, 1);
  await f.bg.finishTask(tracked, { status: 'done', data: { rows: [] } });
  const reserved = await f.bg.reserveBrowser('publish:101'); assert.equal(reserved, false); assert.equal(f.liveTabs.length, 1); assert.equal(f.liveTabs[0].id, 8);
  evidence.push({ name: 'reclaimed attribution opens duplicate and leaves orphan blocking slot', created: f.created.map(t => t.id), removed: f.removed, leftover: f.liveTabs, nextPublishReserved: reserved });
}
{
  const f = await fixture({ tabs: [{ id: 9, url: 'https://creator.xiaohongshu.com/publish/publish?job_id=101' }] });
  await f.bg.payloadForJob(101); assert.equal(f.bg.trackedJobs.get(101).tabId, undefined);
  evidence.push({ name: 'recovered publish loses owner tab binding', trackedTabId: f.bg.trackedJobs.get(101).tabId ?? null });
}
{
  const compiled = await build({ entryPoints: [resolve(root, 'apps/extension/src/lib/keyword-runner.ts')], bundle: true, format: 'iife', globalName: 'ProbeRunner', platform: 'browser', write: false });
  const context = vm.createContext({ URL }); vm.runInContext(compiled.outputFiles[0].text, context);
  let blocks = 0, closes = 0, finishAttempts = 0;
  const claim = { leaseId: 'lease', task: { id: 5, revision: 1, phase: 'details', counts: { saved: 0, partial: 0 }, saveLimit: 1, intervalMs: 2000 }, pending: [{ noteId: 'fixture', card: { url: 'https://www.xiaohongshu.com/explore/000000000000000000000013' } }] };
  const runner = new context.ProbeRunner.KeywordRunner({ api: async path => { if (path.endsWith('/claim')) return { claim }; if (path.endsWith('/heartbeat')) return { task: claim.task }; if (path.endsWith('/finish')) { finishAttempts++; throw new Error('network unavailable'); } throw new Error('Unexpected keyword path ' + path); }, ownerId: async () => 'fixture', enabled: async () => true, reserve: async () => true, release: () => {}, priorityWaiting: async () => false, open: async () => 22, close: async () => { closes++; }, focus: async () => {}, page: async () => ({ state: 'blocked', reason: 'CAPTCHA', cards: [], exhausted: false }), sleep: async () => {}, now: () => 0, block: async () => { blocks++; } });
  await runner.run(); assert.equal(finishAttempts, 1); assert.equal(blocks, 0); assert.equal(closes, 1);
  evidence.push({ name: 'CAPTCHA + result network failure loses local safety block and closes verification page', finishAttempts, localBlocks: blocks, tabCloses: closes });
}
{
  const f = await fixture({ tabs: [{ id: 6, url: 'https://www.xiaohongshu.com/explore' }] });
  const ids = [1, 2, 3].map(n => String(n).padStart(24, '0'));
  for (const id of ids) f.bg.queueDeepCollect('https://www.xiaohongshu.com/explore/' + id);
  for (let probeAttempt = 0; probeAttempt < 1000 && !f.created.length; probeAttempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(f.created.length, 'Expected the first fixture collection tab within the bounded wait');
  await f.bg.cancelDeepCollect(ids[0]);
  f.chrome.runtime.onMessage.listeners[0]({ type: 'COLLECT_URL_DONE', noteId: ids[0], ok: true }, { tab: f.created[0] }, () => {});
  for (let probeAttempt = 0; probeAttempt < 1000 && f.created.length < 2; probeAttempt++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(f.created.length >= 2, 'Expected the next fixture collection tab within the bounded wait');
  assert.ok(f.created[1].url.includes(ids[2])); assert.ok(!f.created.some(t => t.url.includes(ids[1])));
  f.chrome.runtime.onMessage.listeners[0]({ type: 'COLLECT_URL_DONE', noteId: ids[2], ok: true }, { tab: f.created[1] }, () => {});
  await new Promise(resolve => setTimeout(resolve, 0));
  evidence.push({ name: 'cancel executing deep queue head also skips next unrelated item', canceled: ids[0], skipped: ids[1], openedIds: f.created.map(t => ids.find(id => t.url.includes(id))), remaining: [...f.bg.deepQueue] });
}
console.log(JSON.stringify(evidence, null, 2));
await writeFile(resolve(root, 'data/ext-architecture-probe-results.json'), JSON.stringify(evidence, null, 2));
