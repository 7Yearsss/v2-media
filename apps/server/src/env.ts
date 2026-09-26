export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  aiBaseUrl: (process.env.AI_BASE_URL ?? "").replace(/\/$/, ""),
  aiApiKey: process.env.AI_API_KEY ?? "",
  aiModel: process.env.AI_MODEL ?? "gpt-4o-mini",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  authSecret: process.env.AUTH_SECRET ?? "dev-only-secret",
  dataDir: process.env.DATA_DIR ?? new URL("../data", import.meta.url).pathname,
};
