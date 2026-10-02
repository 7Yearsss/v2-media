import { makeApp, registerUser, authed } from '../../../apps/server/test/helpers.ts';
import { drafts, hostedAccounts, publishJobs, jobs, noteMetrics, postmortemReports, accountSnapshots, collections, collectedNotes, collectionAnalyses } from '../../../apps/server/src/db/schema.ts';
import { eq, sql } from 'drizzle-orm';

// Isolated PGlite; no env file, network, server, production connection or credentials.
const { app, db } = await makeApp();
const { token, userId } = await registerUser(app, 'architecture-probe@test.invalid');
const [account] = await db.insert(hostedAccounts).values({ userId, platform:'xhs', xhsUserId:'fixture-account', nickname:'fixture' }).returning();
const [draft] = await db.insert(drafts).values({ userId, title:'fixture', images:[{ url:'https://example.invalid/fixture.png' }] }).returning();
const [pub] = await db.insert(publishJobs).values({ userId, draftId:draft!.id, accountId:account!.id, status:'canceled', draftSnapshot:{title:'fixture',content:'fixture',tags:[],images:[{url:'https://example.invalid/fixture.png'}]} }).returning();
const post = (path:string, body:unknown) => app.request(path, authed(token,{ method:'POST', body:JSON.stringify(body) }));
const done = { status:'done' };
const first = await post(`/api/ext/publish/${pub!.id}/result`, done);
const second = await post(`/api/ext/publish/${pub!.id}/result`, done);
const [revived] = await db.select().from(publishJobs).where(eq(publishJobs.id,pub!.id));
const readbacks = await db.select().from(jobs).where(eq(jobs.type,'readback'));
console.log(JSON.stringify({probe:'publish receipt after cancel and duplicate',statuses:[first.status,second.status],finalStatus:revived!.status,readbackCount:readbacks.length}));
await db.update(publishJobs).set({outcome:'verified',noteId:'note-a',publishedAt:new Date(Date.now()-3600000)}).where(eq(publishJobs.id,pub!.id));
const [pubB] = await db.insert(publishJobs).values({userId,draftId:draft!.id,accountId:account!.id,status:'done',outcome:'verified',noteId:'note-b'}).returning();
const [metricJob] = await db.insert(jobs).values({userId,type:'metrics',status:'pending',payload:{publishJobId:pub!.id,noteId:'note-a'}}).returning();
const metricReceipt = {status:'done',data:{rows:[{noteId:'note-b',likes:3,collects:0,comments:0,shares:0}]}};
const mr1 = await post(`/api/ext/tasks/${metricJob!.id}/result`,metricReceipt);
const mr2 = await post(`/api/ext/tasks/${metricJob!.id}/result`,metricReceipt);
const metrics = await db.select().from(noteMetrics);
console.log(JSON.stringify({probe:'unclaimed metrics receipt, wrong payload note and duplicate',statuses:[mr1.status,mr2.status],count:metrics.length,expectedPublishJob:pub!.id,actualPublishJobs:metrics.map(m=>m.publishJobId),expectedNote:'note-a',actualNotes:metrics.map(m=>m.noteId)}));
await db.insert(postmortemReports).values({userId,publishJobId:pubB!.id,model:'fixture',promptVersion:'fixture',evidence:{note:{},content:{},metrics:[],gaps:[]} as any});
await db.insert(accountSnapshots).values({userId,accountId:account!.id,followers:12});
const remove = await app.request(`/api/accounts/${account!.id}`,authed(token,{method:'DELETE'}));
console.log(JSON.stringify({probe:'unbind account deletes historical evidence',status:remove.status,publishJobs:(await db.select().from(publishJobs)).length,reports:(await db.select().from(postmortemReports)).length,accountSnapshots:(await db.select().from(accountSnapshots)).length,metrics:(await db.select().from(noteMetrics)).map(m=>({noteId:m.noteId,publishJobId:m.publishJobId}))}));

let release!: (value:string)=>void;
let calls=0;
const ai={complete:async()=>{ calls++; if(calls===1)return new Promise<string>(resolve=>{release=resolve;}); return '{}'; }};
const analysisApp=await makeApp(ai);
const analysisUser=await registerUser(analysisApp.app,'analysis-probe@test.invalid');
const [col]=await analysisApp.db.insert(collections).values({userId:analysisUser.userId,name:'fixture'}).returning();
await analysisApp.db.insert(collectedNotes).values({userId:analysisUser.userId,collectionId:col!.id,noteId:'fixture-note',title:'fixture',content:'fixture',cover:''});
const ar=await analysisApp.app.request(`/api/collections/${col!.id}/analyze`,authed(analysisUser.token,{method:'POST',body:'{}'}));
const analysis=await ar.json() as any;
for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,10));
await analysisApp.db.update(collectionAnalyses).set({createdAt:sql`now()-interval '13 minutes'`}).where(eq(collectionAnalyses.id,analysis.id));
const stale=await analysisApp.app.request(`/api/collections/${col!.id}/analyses/${analysis.id}`,authed(analysisUser.token));
const staleBody=await stale.json() as any;
release('fixture hypotheses');
let final;
for(let i=0;i<100;i++){
  [final]=await analysisApp.db.select().from(collectionAnalyses).where(eq(collectionAnalyses.id,analysis.id));
  if(final?.status==='done')break;
  await new Promise(resolve=>setTimeout(resolve,10));
}
console.log(JSON.stringify({probe:'analysis late model answer after stale reap',initialStatus:ar.status,reapedStatus:staleBody.status,finalStatus:final?.status,finalError:final?.error,modelCalls:calls}));
const heartbeat={accounts:[{xhsUserId:'concurrent-fixture',nickname:'fixture',subType:'pc',status:'online'}]};
const hrs=await Promise.all([post('/api/ext/accounts/heartbeat',heartbeat),post('/api/ext/accounts/heartbeat',heartbeat)]);
const duplicates=await db.select().from(hostedAccounts).where(eq(hostedAccounts.xhsUserId,'concurrent-fixture'));
console.log(JSON.stringify({probe:'concurrent account heartbeat',statuses:hrs.map(r=>r.status),accountCount:duplicates.length}));
