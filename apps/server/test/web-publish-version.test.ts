import { randomUUID } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { drafts, hostedAccounts, publishJobs } from "../src/db/schema";
import { authed, makeApp, registerUser } from "./helpers";

let bundle: string;
beforeAll(async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
    stdin: { contents: 'export * from "./web/src/lib/publish-version.ts"; export { setSession, api } from "./web/src/lib/api.ts";', resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts" },
    bundle: true, write: false, format: "iife", globalName: "publishClient", platform: "browser",
    define: { "import.meta.env.VITE_API_BASE_URL": "undefined", "process.env.NODE_ENV": '"test"' },
  });
  bundle = result.outputFiles[0]!.text;
});

async function fixture() {
  const f = await makeApp(); const { token, userId } = await registerUser(f.app);
  const [account] = await f.db.insert(hostedAccounts).values({ userId, xhsUserId: "original-xhs", nickname: "原账号", positioning: "原定位" }).returning();
  const [draft] = await f.db.insert(drafts).values({ userId, title: "原发布标题", content: "原发布正文", images: [{ url: "https://example.com/old.png" }] }).returning();
  const original = await (await f.app.request("/api/publish/jobs", authed(token, { method: "POST", body: JSON.stringify({ draftId: draft!.id, accountId: account!.id }) }))).json() as any;
  await f.app.request(`/api/publish/jobs/${original.id}/cancel`, authed(token, { method: "POST" }));
  const stored = new Map<string, string>(); const window = new EventTarget();
  const calls: { url: string; body: unknown }[] = []; let loseResponse = false;
  const vm = createContext({
    window, localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    crypto: { randomUUID }, AbortController, Blob, FormData, Event, URL, URLSearchParams, setTimeout, clearTimeout, console,
    fetch: async (url: string, init: RequestInit) => {
      if (!url.startsWith("/api/")) throw new Error(`external URL refused: ${url}`);
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const response = await f.app.request(url, init);
      if (loseResponse && url.endsWith("/retry")) { loseResponse = false; throw new Error("offline after commit"); }
      return response;
    },
  });
  runInContext(bundle, vm); const client = vm.publishClient as any;
  client.setSession(token, { id: userId, email: "a@b.co" });
  return { ...f, token, userId, account: account!, draft: draft!, original, client, calls, loseNextResponse: () => { loseResponse = true; } };
}

describe("actual workbench original publication version client (offline)", () => {
  it("keeps frozen labels and warns about changed draft and persona", async () => {
    const f = await fixture();
    const changedDraft = { ...f.draft, title: "改后的草稿标题", content: "改后的正文", tags: ["新标签"] };
    const changedAccount = { ...f.account, nickname: "改后昵称", positioning: "新定位", personaVersion: 1 };
    expect(f.client.publishVersionLabels(f.original, changedDraft, changedAccount)).toEqual({ draftTitle: "原发布标题", accountName: "原账号" });
    expect(f.client.comparePublishVersion(f.original, changedDraft, changedAccount)).toEqual({ draftChanged: true, personaChanged: true });
    expect(f.client.publishVersionLabels({ ...f.original, draftSnapshot: null, accountSnapshot: null }, changedDraft, changedAccount)).toEqual({ draftTitle: "改后的草稿标题", accountName: "改后昵称" });
  });

  it("reuses the same operation after a committed response is lost, without sending mutable draft parameters", async () => {
    const f = await fixture();
    await f.db.update(drafts).set({ title: "新稿", content: "新正文" }).where(eq(drafts.id, f.draft.id));
    const selected = f.client.selectOriginalRetry(f.original);
    f.loseNextResponse(); await expect(f.client.submitOriginalRetry(selected)).rejects.toMatchObject({ name: "ApiError", status: 0 });
    expect(await f.db.select().from(publishJobs)).toHaveLength(2);
    const returned = await f.client.submitOriginalRetry(selected);
    const requests = f.calls.filter(call => call.url.endsWith("/retry"));
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]!.body).toEqual({ operationId: selected.operationId });
    expect(returned.draftSnapshot.title).toBe("原发布标题"); expect(await f.db.select().from(publishJobs)).toHaveLength(2);
    await expect(f.client.submitOriginalRetry(f.client.selectOriginalRetry(f.original))).rejects.toMatchObject({ status: 409 });
    expect(await f.db.select().from(publishJobs)).toHaveLength(2);
  });

  it("does not submit a previously confirmed retry under another user's authorization", async () => {
    const f = await fixture(); const selected = f.client.selectOriginalRetry(f.original);
    const other = await registerUser(f.app, "other@example.com"); f.client.setSession(other.token, { id: other.userId, email: "other@example.com" });
    await expect(f.client.submitOriginalRetry(selected)).rejects.toMatchObject({ name: "SessionChangedError" });
    expect(f.calls).toHaveLength(0); expect(await f.db.select().from(publishJobs)).toHaveLength(1);
  });
});
