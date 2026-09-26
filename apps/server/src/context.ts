import type { Db } from "./db";
import type { AiClient } from "./modules/ai";

/** 依赖注入容器：测试里可替换 db / ai。 */
export interface Deps {
  db: Db;
  ai: AiClient;
  now: () => Date;
}
