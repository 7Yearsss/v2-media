export type RuntimeMode = "local-isolated" | "production-readonly" | "production-worker";
export interface ServerRuntimeStatus { ok: boolean; runtimeMode?: RuntimeMode; schemaVersion?: number }
