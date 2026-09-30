export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  skipDbMigrations: process.env.SKIP_DB_MIGRATIONS === "1",
  disableMediaMaintenance: process.env.DISABLE_MEDIA_MAINTENANCE === "1",
  aiBaseUrl: (process.env.AI_BASE_URL ?? "").replace(/\/$/, ""),
  aiApiKey: process.env.AI_API_KEY ?? "",
  aiModel: process.env.AI_MODEL ?? "gpt-4o-mini",
  /** AI 网关单次请求超时（毫秒），网关不响应时防挂死。 */
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 120_000),
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  authSecret: process.env.AUTH_SECRET ?? "dev-only-secret",
  dataDir: process.env.DATA_DIR ?? new URL("../data", import.meta.url).pathname,
  // R2（S3 兼容）媒体转存；四个变量任一缺失则停用，图片继续走 /api/media/proxy
  r2Endpoint: (process.env.R2_ENDPOINT ?? "").replace(/\/$/, ""),
  r2Bucket: process.env.R2_BUCKET ?? "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  // 对外可达的站点地址（生成给插件用的绝对媒体 URL）；空则用请求 origin
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  // 媒体 GC：周期分钟数（默认每小时），桶容量上限字节（默认 ~5GB，R2 免费额度 10GB）
  mediaGcMinutes: Number(process.env.MEDIA_GC_MINUTES ?? 60),
  r2MaxBytes: Number(process.env.R2_MAX_BYTES ?? 5_000_000_000),
  // 媒体画质档位：free 档压缩省空间（以后会员/pro 档存原画质）
  mediaImageMaxWidth: Number(process.env.MEDIA_IMAGE_MAX_WIDTH ?? 1080),
  mediaImageQuality: Number(process.env.MEDIA_IMAGE_QUALITY ?? 70),
  mediaVideoMaxBytes: Number(process.env.MEDIA_VIDEO_MAX_BYTES ?? 300_000_000),
  mediaVideoMaxBytesPro: Number(process.env.MEDIA_VIDEO_MAX_BYTES_PRO ?? 1_000_000_000),
};
