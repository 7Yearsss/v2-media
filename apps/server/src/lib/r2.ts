import { AwsClient } from "aws4fetch";

import { env } from "../env";

export interface R2Object {
  key: string;
  size: number;
  lastModified: number;
}

/** R2（S3 兼容）对象存储；未配置凭据时 createR2 返回 null，调用方回退原逻辑。 */
export interface R2Storage {
  head(key: string): Promise<boolean>;
  put(key: string, body: ArrayBuffer, contentType: string): Promise<void>;
  /** 流式上传大文件（视频）：不整包进内存。 */
  putStream(
    key: string,
    body: import("node:stream").Readable,
    contentType: string,
    contentLength: number,
  ): Promise<void>;
  get(key: string, rangeHeader?: string): Promise<Response | null>;
  list(prefix: string): Promise<R2Object[]>;
  /** true = 已不存在/删除成功；false = 删除失败（对象可能还在）。 */
  delete(key: string): Promise<boolean>;
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
    async putStream(key, body, contentType, contentLength) {
      const res = await client.fetch(url(key), {
        method: "PUT",
        headers: {
          "content-type": contentType,
          "content-length": String(contentLength),
          // stream body 无法算 hash —— aws4fetch 允许显式 UNSIGNED-PAYLOAD
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        },
        body: body as any,
        // Node fetch(undici) 流式 body 必需
        duplex: "half",
      } as any);
      if (!res.ok) throw new Error(`r2 put ${res.status}`);
    },
    async get(key, rangeHeader) {
      const res = await client
        .fetch(url(key), rangeHeader ? { headers: { range: rangeHeader } } : undefined)
        .catch(() => null);
      return res && (res.ok || res.status === 206) ? res : null;
    },
    async list(prefix) {
      const out: R2Object[] = [];
      let token = "";
      do {
        const res = await client.fetch(
          `${base}?list-type=2&prefix=${encodeURIComponent(prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`,
        );
        if (!res.ok) throw new Error(`r2 list ${res.status}`);
        const xml = await res.text();
        for (const m of xml.matchAll(
          /<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<LastModified>([\s\S]*?)<\/LastModified>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
        )) {
          out.push({
            key: m[1]!,
            lastModified: Date.parse(m[2]!),
            size: Number(m[3]),
          });
        }
        token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(
          xml,
        )?.[1] ?? "";
      } while (token);
      return out;
    },
    async delete(key) {
      const res = await client.fetch(url(key), { method: "DELETE" });
      return res.ok || res.status === 404;
    },
  };
}
