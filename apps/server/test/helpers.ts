import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { createApp } from "../src/app";
import type { Deps } from "../src/context";
import type { Db } from "../src/db";
import { migrate } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import type { AiClient } from "../src/modules/ai";

export async function makeApp(ai?: AiClient) {
  const db = drizzle(new PGlite(), { schema }) as unknown as Db;
  await migrate(db);
  const deps: Deps = {
    db,
    ai: ai ?? { complete: async (_sys, user) => `标题：改写后的标题\n正文：改写后的正文 ${user.length}` },
    now: () => new Date(),
  };
  return { app: createApp(deps), db, deps };
}

export async function registerUser(app: ReturnType<typeof createApp>, email = "a@b.co") {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2x" }),
  });
  const body = (await res.json()) as any;
  if (!body.token) throw new Error(`register failed: ${res.status} ${JSON.stringify(body)}`);
  return { token: body.token as string, userId: body.user.id as number };
}

export function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  };
}
