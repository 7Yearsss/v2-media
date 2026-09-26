import { AwsClient } from "aws4fetch";

import { env } from "../env";

/** R2（S3 兼容）对象存储；未配置凭据时 createR2 返回 null，调用方回退原逻辑。 */
export interface R2Storage {
  head(key: string): Promise<boolean>;
  put(key: string, body: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<Response | null>;
}

export function createR2(): R2Storage | null {
  if (
    !env.r2Endpoint ||
    !env.r2Bucket ||
    !env.r2AccessKeyId ||
    !env.r2SecretAccessKey
  )
    return null;
  const client = new AwsClient({
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey,
    service: "s3",
    region: "auto",
  });
  const base = `${env.r2Endpoint.replace(/\/$/, "")}/${env.r2Bucket}`;
  const url = (key: string) =>
    `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async head(key) {
      const res = await client
        .fetch(url(key), { method: "HEAD" })
        .catch(() => null);
      return res?.ok ?? false;
    },
    async put(key, body, contentType) {
      const res = await client.fetch(url(key), {
        method: "PUT",
        headers: { "content-type": contentType },
        body,
      });
      if (!res.ok) throw new Error(`r2 put ${res.status}`);
    },
    async get(key) {
      const res = await client.fetch(url(key)).catch(() => null);
      return res && res.ok ? res : null;
    },
  };
}
