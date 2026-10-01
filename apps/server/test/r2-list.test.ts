import { expect, it } from "vitest";
import { parseR2ListXml } from "../src/lib/r2";

// R2 真实响应：字段顺序是 Key → Size → LastModified → ETag
const entry = (key: string, size: number, at: string) =>
  `<Contents><Key>${key}</Key><Size>${size}</Size><LastModified>${at}</LastModified><ETag>&quot;x&quot;</ETag><StorageClass>STANDARD</StorageClass></Contents>`;

it("R2 列表解析：Size 在 LastModified 之前时每个对象都能列出且大小/时间不错位", () => {
  const xml = `<ListBucketResult><Name>b</Name>${entry("img/a", 71236, "2026-09-30T10:28:11.524Z")}${entry("img/b", 109488, "2026-09-30T10:29:11.996Z")}${entry("img/c", 70, "2026-09-26T06:28:43.348Z")}<IsTruncated>false</IsTruncated></ListBucketResult>`;
  expect(parseR2ListXml(xml)).toEqual([
    { key: "img/a", size: 71236, lastModified: Date.parse("2026-09-30T10:28:11.524Z") },
    { key: "img/b", size: 109488, lastModified: Date.parse("2026-09-30T10:29:11.996Z") },
    { key: "img/c", size: 70, lastModified: Date.parse("2026-09-26T06:28:43.348Z") },
  ]);
});

it("字段顺序反过来、或空桶也不出错", () => {
  const swapped = "<Contents><Key>vid/x</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>5</Size></Contents>";
  expect(parseR2ListXml(swapped)).toEqual([{ key: "vid/x", size: 5, lastModified: Date.parse("2026-01-01T00:00:00.000Z") }]);
  expect(parseR2ListXml("<ListBucketResult></ListBucketResult>")).toEqual([]);
});
