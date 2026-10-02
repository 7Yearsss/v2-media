import type { Deps } from "./context";

import type { RuntimeMode } from "@v2media/shared";
export type { RuntimeMode } from "@v2media/shared";
export const RUNTIME_MODES = ["local-isolated", "production-readonly", "production-worker"] as const;

export function runtimeMode(value: string | undefined): RuntimeMode {
  const mode = value || "local-isolated";
  if (!RUNTIME_MODES.includes(mode as RuntimeMode)) throw new Error("V2MEDIA_RUNTIME_MODE must be local-isolated, production-readonly or production-worker");
  return mode as RuntimeMode;
}

/** Tests inject an isolated database; omitting the mode keeps that existing seam. */
export function isReadOnly(deps: Pick<Deps, "runtimeMode">) {
  return deps.runtimeMode === "production-readonly";
}

export function assertWritable(deps: Pick<Deps, "runtimeMode">) {
  if (isReadOnly(deps)) throw new Error("production-readonly forbids mutations and background workers");
}

export interface RuntimeConfig {
  runtimeMode: RuntimeMode;
  databaseUrl: string;
  authSecret: string;
  encryptionKey: string;
  r2Configured?: boolean;
  r2Bucket?: string;
  localR2Bucket?: string;
}

export function validateRuntimeConfig(config: RuntimeConfig) {
  if (config.runtimeMode === "local-isolated") {
    if (config.databaseUrl) throw new Error("local-isolated refuses DATABASE_URL; use an isolated PGlite database");
    if (config.r2Configured && (!config.localR2Bucket || config.localR2Bucket !== config.r2Bucket || config.r2Bucket?.toLowerCase() === "v2-media")) {
      throw new Error("local-isolated R2 requires LOCAL_R2_BUCKET matching a dedicated R2_BUCKET; the production v2-media bucket is forbidden");
    }
    return;
  }
  if (!config.databaseUrl || !/^postgres(?:ql)?:\/\//.test(config.databaseUrl)) throw new Error("production modes require an explicit PostgreSQL DATABASE_URL");
  if (config.authSecret.length < 32 || config.authSecret === "dev-only-secret") throw new Error("production modes require AUTH_SECRET with at least 32 characters");
  if (config.runtimeMode === "production-worker" && !/^[0-9a-f]{64}$/i.test(config.encryptionKey)) throw new Error("production-worker requires a 32-byte hex ENCRYPTION_KEY");
}
