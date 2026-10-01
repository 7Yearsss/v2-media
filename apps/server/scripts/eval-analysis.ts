/**
 * 对运行中的本地服务（:3000）跑一次真实 AI 分析并打分：
 *   EVAL_EMAIL=.. EVAL_PASSWORD=.. npx tsx apps/server/scripts/eval-analysis.ts [collectionId] [定位]
 * 打分器见 src/lib/analysis-grader.ts；失败项就是下一步该补进提示词的内容。
 */
import { gradeInsight } from "../src/lib/analysis-grader";

const base = process.env.EVAL_BASE ?? "http://127.0.0.1:3000";
const call = async (path: string, token: string | null, body?: unknown) => {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const { token } = await call("/api/auth/login", null, { email: process.env.EVAL_EMAIL, password: process.env.EVAL_PASSWORD });
const cols = (await call("/api/collections", token)).items as Array<{ id: number; name: string }>;
const colId = Number(process.argv[2] ?? cols[0]?.id);
const positioning = process.argv[3];

const t0 = Date.now();
let a = await call(`/api/collections/${colId}/analyze`, token, { positioning });
while (a.status === "running") {
  await new Promise((r) => setTimeout(r, 3000));
  a = await call(`/api/collections/${colId}/analyses/${a.id}`, token);
}
if (a.status === "failed") throw new Error(`分析失败：${a.error}`);
console.log(`分析耗时 ${Math.round((Date.now() - t0) / 1000)}s，样本 ${a.noteCount} 篇`);

const notes = (await call(`/api/notes?collectionId=${colId}&limit=200`, token)).items as any[];
const details = await Promise.all(notes.map((n) => call(`/api/notes/${n.id}`, token)));
const ctx = {
  titles: notes.map((n) => n.title),
  comments: details.flatMap((d) => ((d.commentsData ?? d.comments ?? []) as any[]).map((c) => String(c?.content ?? ""))),
};
console.log(JSON.stringify(a.data.insight, null, 2));
const g = gradeInsight(a.data.insight, ctx);
console.log(`\n得分 ${g.score}`, g.failures.length ? `\n失败项：\n- ${g.failures.join("\n- ")}` : "（全过）");
