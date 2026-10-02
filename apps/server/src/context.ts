import type { Db } from "./db";
import type { R2Storage } from "./lib/r2";
import type { AiClient } from "./modules/ai";
import type { RuntimeMode } from "./runtime";

/** 依赖注入容器：测试里可替换 db / ai。 */
export interface Deps {
  db: Db;
  ai: AiClient;
  now: () => Date;
  /** 可选：配置 R2_* 环境变量后启用媒体转存。 */
  r2?: R2Storage | null;
  /** 上传持久暂存目录；测试使用独立临时目录。 */
  uploadDir?: string;
  runtimeMode?: RuntimeMode;
}
