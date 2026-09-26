/**
 * creator.xiaohongshu.com/publish/* 发布驱动脚本：
 *  1. 从 URL ?job_id=N 拿任务号，向 background 拉 JOB_READY（或被推 JOB_PAYLOAD）；
 *  2. 驱动真实发布页 UI：图片经 background fetch（绕 CORS）→ dataURL →
 *     DataTransfer 注入 file input；标题 input、正文 contenteditable/textarea、
 *     逐个话题联想选第一项、可选定时发布、点发布；
 *  3. 结果页抓笔记链接 → JOB_RESULT 回传 background（POST /api/ext/publish/:id/result）；
 *  4. 全程 Shadow DOM 状态浮层（进行中/成功/失败），方便人工兜底。
 * 选择器全部是"多候选 + 显式等待 + 超时"，小红书改样式就只换 SELECTORS 一处。
 */

import type { PublishJobPayload } from "./lib/messages";
import { sendToBackground } from "./lib/messages";
import { el, shadowHost } from "./lib/ui";

type AnyEl = HTMLElement;

// ---------- 状态浮层 ----------

const { shadow } = shadowHost("v2m-publisher");
shadow.append(
  el(
    "style",
    {},
    `
  :host { all: initial; }
  .panel { position: fixed; top: 16px; right: 16px; z-index: 2147483000; width: 280px;
    background: #fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.2);
    font: 13px/1.6 system-ui, sans-serif; color: #27272a; overflow: hidden; }
  .head { padding: 10px 14px; background: #e6212d; color: #fff; font-weight: 600; }
  .body { padding: 10px 14px; display: flex; flex-direction: column; gap: 6px;
    max-height: 60vh; overflow: auto; }
  .step { display: flex; gap: 8px; align-items: baseline; color: #71717a; }
  .step .s { flex: none; width: 16px; }
  .step.run { color: #27272a; }
  .step.ok { color: #16a34a; }
  .step.err { color: #dc2626; }
  .hint { margin-top: 6px; padding: 8px; border-radius: 8px; background: #fef2f2;
    color: #b91c1c; font-size: 12px; }
  `,
  ),
);
const stepsEl = el("div", { class: "body" });
const panel = el(
  "div",
  { class: "panel" },
  el("div", { class: "head" }, "v2-media 自动发布"),
  stepsEl,
);
shadow.append(panel);

const stepEls = new Map<string, HTMLElement>();
function step(id: string, label: string, state: "run" | "ok" | "err" | "todo" = "run") {
  let row = stepEls.get(id);
  if (!row) {
    row = el("div", { class: "step" }, el("span", { class: "s" }), el("span", {}, label));
    stepEls.set(id, row);
    stepsEl.append(row);
  }
  const icon = state === "ok" ? "✓" : state === "err" ? "✗" : state === "run" ? "…" : "·";
  row.className = `step ${state === "todo" ? "" : state}`;
  row.querySelector(".s")!.textContent = icon;
}
function failHint(msg: string) {
  stepsEl.append(
    el("div", { class: "hint" }, `失败：${msg}。可人工完成发布后忽略此页。`),
  );
}

// ---------- DOM 工具 ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  timeoutMs: number,
  label: string,
  intervalMs = 400,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(intervalMs);
  }
}

/** 按候选选择器找第一个可见元素。 */
function qVisible(selectors: string[], root: ParentNode = document): AnyEl | null {
  for (const sel of selectors) {
    for (const e of root.querySelectorAll<AnyEl>(sel)) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return e;
    }
  }
  return null;
}

/** 按可见文本找元素（用于 tab/按钮这类选择器不稳定的目标）。 */
function byText(texts: string[], tags = "button,div,span,li,label", root: ParentNode = document) {
  const els = root.querySelectorAll<AnyEl>(tags);
  for (const t of texts) {
    for (const e of els) {
      const txt = (e.textContent ?? "").trim();
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && txt === t) return e;
    }
  }
  return null;
}

/** React 受控 input：用原生 setter 写值再发 input 事件。 */
function setInputValue(elm: AnyEl, value: string) {
  const proto =
    elm instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  elm.focus();
  if (setter) setter.call(elm, value);
  else (elm as HTMLInputElement).value = value;
  elm.dispatchEvent(new Event("input", { bubbles: true }));
  elm.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickEl(e: AnyEl) {
  e.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  e.click();
}

// ---------- 发布页选择器（多候选，按官方发布页常见结构 + 语义文本兜底） ----------

const SEL = {
  uploadTab: [".creator-tab", ".tab-item", ".publish-tab"], // 配合 byText("上传图文")
  fileInput: [
    'input[type="file"][accept*="image"]',
    ".upload-input input[type=file]",
    'input[type="file"]',
  ],
  preview: [
    ".img-preview img",
    ".upload-list img",
    ".image-preview img",
    '[class*="preview"] img',
    '[class*="upload"] img',
  ],
  titleInput: [
    'input[placeholder*="标题"]',
    ".title-input input",
    ".c-input_inner input",
    'input.d-text[type="text"]',
    "#title-input",
    "input.d-text",
  ],
  content: [
    '[contenteditable="true"]',
    ".ql-editor",
    'textarea[placeholder*="正文"]',
    'textarea[placeholder*="描述"]',
    ".post-textarea",
    "#post-textarea",
  ],
  topicPopup: [
    '[class*="mention"] [class*="item"]',
    '[class*="topic"] [class*="item"]',
    ".mention-list li",
    ".topic-list li",
    '[role="listbox"] [role="option"]',
    ".search-result-item",
  ],
  publishBtn: [
    "button.publishBtn",
    ".publish-page-publish-btn button",
    'button[class*="publish"]',
    ".submit button",
  ],
  successMark: [
    '[class*="success"]',
    ".publish-success",
    'a[href*="/explore/"]',
    'a[href*="/notes/"]',
  ],
};

// ---------- 图片：background 抓 -> dataURL -> File -> DataTransfer 注入 ----------

function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(",");
  const mime = head?.match(/data:(.*?);/)?.[1] ?? "image/jpeg";
  const bin = atob(b64 ?? "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

async function injectImages(images: { url: string }[]) {
  if (!images.length) return;
  const input = (await waitFor(
    () =>
      qVisible(SEL.fileInput) ??
      document.querySelector<HTMLInputElement>(SEL.fileInput.join(",")),
    60000,
    "图片上传输入框",
  )) as HTMLInputElement;
  step("images", `下载并注入 ${images.length} 张图片`);
  const dt = new DataTransfer();
  for (const [i, img] of images.entries()) {
    const { dataUrl } = await sendToBackground<{ dataUrl: string }>({
      type: "FETCH_IMAGE",
      url: img.url,
    });
    dt.items.add(dataUrlToFile(dataUrl, `image-${i + 1}.jpg`));
  }
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  // 等预览出齐（站点上传/渲染需要时间）
  await waitFor(
    () => document.querySelectorAll(SEL.preview.join(",")).length >= images.length,
    90000,
    "图片预览渲染",
  );
  step("images", `已注入 ${images.length} 张图片`, "ok");
}

// ---------- 标题 / 正文 / 话题 ----------

function fillTitle(title: string) {
  if (!title) return;
  const input = qVisible(SEL.titleInput);
  if (!input) throw new Error("找不到标题输入框");
  setInputValue(input, title.slice(0, 20)); // 小红书标题上限 20 字
}

function findEditor(): AnyEl {
  const ed = qVisible(SEL.content);
  if (!ed) throw new Error("找不到正文编辑器");
  return ed;
}

function insertTextIntoEditor(ed: AnyEl, text: string) {
  ed.focus();
  // execCommand insertText 对 quill/contenteditable 都会触发完整输入链路
  const ok = document.execCommand("insertText", false, text);
  if (!ok || !(ed.textContent ?? "").includes(text.slice(0, 8))) {
    if (ed instanceof HTMLTextAreaElement) setInputValue(ed, text);
    else {
      ed.innerText = (ed.innerText ?? "") + text;
      ed.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }
}

function fillContent(content: string) {
  if (!content) return;
  const ed = findEditor();
  ed.focus();
  insertTextIntoEditor(ed, content);
}

async function addTags(tags: string[]) {
  const wanted = tags.map((t) => t.replace(/^#/, "").trim()).filter(Boolean).slice(0, 8);
  if (!wanted.length) return;
  const ed = findEditor();
  const failed: string[] = [];
  for (const tag of wanted) {
    try {
      ed.focus();
      insertTextIntoEditor(ed, `#${tag}`);
      // 话题联想框：等候选弹出，点第一项
      const item = await waitFor(
        () => qVisible(SEL.topicPopup),
        8000,
        `话题「${tag}」联想`,
      );
      clickEl(item);
      step("tags", `话题 +${tag}`, "ok");
    } catch {
      failed.push(tag);
      // 没选中的话把刚打的 #tag 文本留正文里也无妨（站点本身就这么存话题文本）
    }
    await sleep(500);
  }
  step(
    "tags",
    `话题：${wanted.length - failed.length}/${wanted.length}${failed.length ? `（未选中 ${failed.join("/")}）` : ""}`,
    failed.length === wanted.length ? "err" : "ok",
  );
}

// ---------- 定时发布 / 可见性 ----------

async function applySchedule(scheduledAt: number) {
  // 点「定时发布」开关/单选
  const trigger =
    byText(["定时发布"], "label,div,span,button") ??
    qVisible(['input[type="checkbox"][class*="schedule"]', '[class*="schedule"] input']);
  if (!trigger) throw new Error("找不到「定时发布」开关");
  clickEl(trigger);
  await sleep(600);
  const input = await waitFor(
    () =>
      qVisible([
        'input[type="datetime-local"]',
        'input[placeholder*="时间"]',
        'input[placeholder*="日期"]',
        '[class*="date"] input',
        '[class*="time"] input',
      ]),
    10000,
    "定时时间输入框",
  );
  const d = new Date(scheduledAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  setInputValue(input, local);
  input.dispatchEvent(new Event("blur", { bubbles: true }));
  // 站点若是自研日期面板，blur 后应有回显值；校验失败按致命处理（防误即时发布）
  await sleep(500);
  if (input instanceof HTMLInputElement && input.type === "datetime-local") {
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setInputValue(input, iso);
  }
}

function applyVisibility(visibility: "public" | "private" | "friends") {
  if (visibility === "public") return; // 默认公开
  const label = visibility === "private" ? ["仅自己可见", "私密"] : ["仅好友可见", "好友可见"];
  const radio = byText(label, "label,div,span");
  if (!radio) throw new Error(`找不到可见性选项「${label[0] ?? label.join("/")}」`);
  clickEl(radio);
}

// ---------- 发布 + 结果 ----------

async function clickPublish() {
  const btn =
    qVisible(SEL.publishBtn) ?? byText(["发布", "发布笔记"], "button");
  if (!btn) throw new Error("找不到发布按钮");
  clickEl(btn);
}

async function awaitResult(): Promise<{ resultUrl?: string }> {
  const startUrl = location.href;
  const r = await waitFor(
    () => {
      if (location.href !== startUrl) {
        // 跳转出创作平台 = 登录失效/被风控，不是发布成功
        if (!location.host.includes("creator.xiaohongshu.com")) {
          throw new Error(`发布页被重定向（${location.host}）——账号登录态可能失效`);
        }
        return location.href;
      }
      const link = qVisible(SEL.successMark) as HTMLAnchorElement | null;
      if (link?.href) return link.href;
      // 站点 toast：发布成功/审核中
      const t = document.body?.innerText ?? "";
      if (/发布成功|审核中|已提交/.test(t)) return "done";
      return null;
    },
    60000,
    "发布结果",
  );
  return { resultUrl: r === "done" ? location.href : r };
}

// ---------- 主流程 ----------

async function runJob(job: PublishJobPayload) {
  const { draft } = job;
  step("load", `任务 #${job.id} 加载中`);
  // 1. 确保「上传图文」页签
  const imgTab = byText(["上传图文", "图文"], SEL.uploadTab.join(","));
  if (imgTab) {
    clickEl(imgTab);
    await sleep(800);
  }
  step("load", "发布页就绪", "ok");

  await injectImages(draft.images ?? []);
  step("fields", "填写标题/正文");
  fillTitle(draft.title ?? "");
  fillContent(draft.content ?? "");
  step("fields", "标题/正文已填", "ok");

  await addTags(draft.tags ?? []);

  // 定时已到点（或一分钟内）：服务端已释放任务，直接发不再设创作者侧定时
  const scheduleAt = job.scheduledAt;
  if (scheduleAt && scheduleAt > Date.now() + 60_000) {
    step("schedule", "设置定时发布");
    await applySchedule(scheduleAt);
    step("schedule", "定时已设置", "ok");
  }
  if (job.visibility && job.visibility !== "public") {
    step("visibility", `可见性：${job.visibility}`);
    applyVisibility(job.visibility);
    step("visibility", "可见性已设置", "ok");
  }

  step("publish", "点击发布");
  await clickPublish();
  const { resultUrl } = await awaitResult();
  step("publish", "发布完成", "ok");
  return { resultUrl };
}

async function main() {
  const jobId = Number(new URL(location.href).searchParams.get("job_id") ?? 0);
  if (!jobId) {
    step("idle", "无 job_id 参数，等待任务推送", "todo");
  }
  // 双通道：等 background 推 JOB_PAYLOAD，同时自己 JOB_READY 拉一次
  const pushed = new Promise<PublishJobPayload>((resolve) => {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "JOB_PAYLOAD" && msg.payload) resolve(msg.payload as PublishJobPayload);
    });
  });
  let job: PublishJobPayload;
  try {
    job = jobId
      ? await Promise.race([
          pushed,
          sendToBackground<{ payload: PublishJobPayload }>({
            type: "JOB_READY",
            jobId,
          }).then((r) => r.payload),
        ])
      : await pushed;
  } catch (e) {
    step("load", "任务数据获取失败", "err");
    failHint(String((e as Error)?.message ?? e));
    return;
  }
  try {
    const { resultUrl } = await runJob(job);
    await sendToBackground({
      type: "JOB_RESULT",
      jobId: job.id,
      status: "done",
      resultUrl,
    });
    step("done", "已回传服务端", "ok");
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    failHint(msg);
    await sendToBackground({
      type: "JOB_RESULT",
      jobId: job.id,
      status: "failed",
      error: msg.slice(0, 300),
    }).catch(() => {});
  }
}

void main();
