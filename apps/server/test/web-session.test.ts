import { beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";

let bundle: string;
beforeAll(async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
    stdin: { contents: 'export * from "./web/src/lib/api.ts"; export * from "./web/src/lib/session-query-scope.ts"; export * from "./web/src/lib/user-storage.ts";', resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts" },
    bundle: true, write: false, format: "iife", globalName: "webClient", platform: "browser",
    define: { "import.meta.env.VITE_API_BASE_URL": "undefined", "process.env.NODE_ENV": '"test"' },
  });
  bundle = result.outputFiles[0]!.text;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  const window = new EventTarget();
  const calls: { url: string; init: RequestInit; response: ReturnType<typeof deferred<Response>> }[] = [];
  const vm = createContext({
    window, localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
    fetch: (url: string, init: RequestInit) => {
      const response = deferred<Response>(); calls.push({ url, init, response });
      // Ignore abort deliberately: late network/body arrivals must still be fenced.
      return response.promise;
    },
    AbortController, Blob, FormData, Event, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console,
  });
  runInContext(bundle, vm);
  const client = vm.webClient as any;
  const session = (id: number) => client.setSession(`token-${id}`, { id, email: `user-${id}@offline.test` });
  const storage = (record: unknown, key: string | null = "v2m.session") => {
    if (key === null) stored.clear(); else stored.set(key, JSON.stringify(record));
    const event = new Event("storage"); Object.defineProperty(event, "key", { value: key });
    window.dispatchEvent(event);
  };
  return { client, calls, stored, window, session, storage };
}

describe("actual workbench session client and query scope (offline)", () => {
  it("a delayed 401 from user A cannot clear user B or broadcast expiry", async () => {
    const f = fixture(); f.session(1);
    let expiries = 0; f.window.addEventListener(f.client.UNAUTHORIZED_EVENT, () => expiries++);
    const result = f.client.api.accounts().catch((error: Error) => error);
    const signal = f.calls[0]!.init.signal!;
    f.session(2); expect(signal.aborted).toBe(true);
    f.calls[0]!.response.resolve(new Response(null, { status: 401 }));
    expect(await result).toMatchObject({ name: "SessionChangedError" });
    expect(f.client.getStoredUser()).toMatchObject({ id: 2 });
    expect(f.client.getToken()).toBe("token-2"); expect(expiries).toBe(0);
  });

  it("checks an atomic cross-tab record before its storage event has arrived", async () => {
    const f = fixture(); f.session(1);
    const result = f.client.api.accounts().catch((error: Error) => error);
    f.stored.set("v2m.session", JSON.stringify({ token: "token-2", user: { id: 2, email: "user-2@offline.test" } }));
    f.calls[0]!.response.resolve(new Response(null, { status: 401 }));
    expect(await result).toMatchObject({ name: "SessionChangedError" });
    expect(f.client.getStoredUser()).toMatchObject({ id: 2 });
  });

  it("fences a successful response whose JSON body finishes after the session changes", async () => {
    const f = fixture(); f.session(1); const body = deferred<unknown>();
    const result = f.client.api.draft(11).catch((error: Error) => error);
    expect(f.calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer token-1" });
    f.calls[0]!.response.resolve({ status: 200, ok: true, json: () => body.promise } as Response);
    await Promise.resolve(); f.session(2); body.resolve({ id: 11, title: "A secret" });
    expect(await result).toMatchObject({ name: "SessionChangedError" });
  });

  it("an editor's frozen authorization cannot submit its draft under a new user's token", async () => {
    const f = fixture(); f.session(1); const context = f.client.captureSession(); f.session(2);
    await expect(f.client.api.updateDraft(11, { title: "A text", textVersion: 0 }, context))
      .rejects.toMatchObject({ name: "SessionChangedError" });
    expect(f.calls).toEqual([]);
  });

  it("CSV downloads use the same late-response guard and current 401 handling", async () => {
    const f = fixture(); f.session(1); const body = deferred<Blob>();
    const result = f.client.api.exportNotes({ collectionId: "3", ids: [11, 12] }).catch((error: Error) => error);
    expect(f.calls[0]!.url).toBe("/api/notes/export?collectionId=3&ids=11%2C12");
    f.calls[0]!.response.resolve({ status: 200, ok: true, blob: () => body.promise } as Response);
    await Promise.resolve(); f.session(2); body.resolve(new Blob(["A secret"]));
    expect(await result).toMatchObject({ name: "SessionChangedError" });
    const active = f.client.api.exportNotes().catch((error: Error) => error);
    f.calls[1]!.response.resolve(new Response(null, { status: 401 }));
    expect(await active).toMatchObject({ name: "ApiError", status: 401 });
    expect(f.client.getToken()).toBeNull();
  });

  it("multipart uploads freeze authorization and discard a late media result", async () => {
    const f = fixture(); f.session(1); const context = f.client.captureSession();
    const result = f.client.api.uploadImage(11, 0, new Blob(["image"]), "upload-id", context).catch((error: Error) => error);
    const call = f.calls[0]!; expect(call.init.body).toBeInstanceOf(FormData);
    expect(call.init.headers).toEqual({ Authorization: "Bearer token-1" });
    f.storage({ token: "token-2", user: { id: 2, email: "user-2@offline.test" } });
    call.response.resolve(Response.json({ asset: { id: 3 }, draft: { id: 11 } }));
    expect(await result).toMatchObject({ name: "SessionChangedError" });
    expect(context.signal.aborted).toBe(true);
  });

  it("a cross-tab switch retires both query and mutation caches and cancels pending queries", async () => {
    const f = fixture(); f.session(1); const scope = f.client.sessionQueryScope;
    const previous = scope.getSnapshot(); const oldClient = previous.client;
    oldClient.setQueryData(["draft", 11], { title: "A secret" });
    const mutationBody = deferred<unknown>();
    const mutation = oldClient.getMutationCache().build(oldClient, { mutationKey: ["save"], mutationFn: () => mutationBody.promise });
    const mutationResult = mutation.execute({}).catch(() => undefined);
    const pending = oldClient.fetchQuery({ queryKey: ["accounts"], queryFn: () => f.client.api.accounts() }).catch((error: Error) => error);
    f.storage({ token: "token-2", user: { id: 2, email: "user-2@offline.test" } });
    const current = scope.getSnapshot(); expect(current.epoch).not.toBe(previous.epoch);
    expect(current.client).not.toBe(oldClient);
    expect(oldClient.getQueryCache().getAll()).toHaveLength(0);
    expect(oldClient.getMutationCache().getAll()).toHaveLength(0);
    expect(current.client.getQueryData(["draft", 11])).toBeUndefined();
    f.calls[0]!.response.resolve(Response.json([{ id: "A account" }]));
    await pending; mutationBody.resolve("A result"); await mutationResult;
    expect(oldClient.getQueryCache().getAll()).toHaveLength(0);
    expect(current.client.getMutationCache().getAll()).toHaveLength(0);
    expect(current.client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("storage.clear logs the tab out, and a token replacement for the same user is a fresh epoch", () => {
    const f = fixture({ "v2m.token": "legacy", "v2m.user": JSON.stringify({ id: 1, email: "legacy@offline.test" }) });
    const old = f.client.captureSession(); expect(old.token).toBe("legacy");
    expect(JSON.parse(f.stored.get("v2m.session")!)).toMatchObject({ token: "legacy", user: { id: 1 } });
    f.storage("half-written-token", "v2m.token");
    expect(f.client.captureSession()).toBe(old);
    f.storage({ token: "new-token", user: { id: 1, email: "legacy@offline.test" } });
    expect(f.client.isCurrentSession(old)).toBe(false); const next = f.client.captureSession();
    f.storage(null, null); expect(f.client.getStoredUser()).toBeNull(); expect(next.signal.aborted).toBe(true);
  });

  it("user-local redlines, collection IDs, viewed IDs and positioning are isolated without attributing legacy values", () => {
    const namespaces = ["v2m.bannedWords", "v2media:library-collection-prefs", "v2media:viewed-notes", "v2m.analysis.positioning"];
    const f = fixture(Object.fromEntries(namespaces.map(key => [key, "unattributed legacy value"])));
    f.session(1);
    const a = namespaces.map(key => f.client.captureUserStorage(key));
    for (const record of a) { expect(record.getItem()).toBeNull(); expect(record.setItem("A private value")).toBe(true); }
    f.session(2);
    const b = namespaces.map(key => f.client.captureUserStorage(key));
    for (let i = 0; i < b.length; i++) {
      expect(b[i].getItem()).toBeNull(); expect(b[i].key).not.toBe(a[i].key);
      expect(a[i].getItem()).toBeNull(); expect(a[i].setItem("late A callback")).toBe(false);
      expect(b[i].setItem("B private value")).toBe(true);
      expect(f.stored.get(a[i].key)).toBe("A private value");
      expect(f.stored.get(namespaces[i]!)).toBe("unattributed legacy value");
    }
    f.session(1);
    for (const key of namespaces) expect(f.client.captureUserStorage(key).getItem()).toBe("A private value");
    f.client.clearSession();
    const anonymous = f.client.captureUserStorage(namespaces[0]);
    expect(anonymous.key).toBeNull(); expect(anonymous.setItem("anonymous value")).toBe(false);
  });
});
