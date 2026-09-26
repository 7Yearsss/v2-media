import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { users } from "../db/schema";
import { hashPassword, signToken, verifyPassword, verifyToken } from "../lib/auth";

const credSchema = z.object({ email: z.string().email(), password: z.string().min(6) });

type AuthEnv = { Variables: { userId: number } };

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = verifyToken(token);
  if (userId == null) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});

export function authModule(deps: Deps) {
  const app = new Hono();

  app.post("/register", async (c) => {
    const parsed = credSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid email or password (min 6)" }, 400);
    const { email, password } = parsed.data;
    const existing = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length) return c.json({ error: "email already registered" }, 409);
    const [user] = await deps.db
      .insert(users)
      .values({ email, passwordHash: hashPassword(password) })
      .returning({ id: users.id, email: users.email });
    return c.json({ token: signToken(user!.id), user });
  });

  app.post("/login", async (c) => {
    const parsed = credSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid email or password" }, 400);
    const [user] = await deps.db
      .select()
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash))
      return c.json({ error: "wrong email or password" }, 401);
    return c.json({ token: signToken(user.id), user: { id: user.id, email: user.email } });
  });

  return app;
}
