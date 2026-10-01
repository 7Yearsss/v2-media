/**
 * 工作台页面 <-> 插件双向桥（v2-store 同款模式）。
 * 本脚本只注入受信任的工作台 origin（manifest matches 由构建期 EXT_APP_ORIGINS 注入）。
 * 工作台 window.postMessage({source:"v2m-web", type, requestId, payload})，
 * 这里转发 background，回包 {source:"v2m-ext", requestId, ok, result, error}。
 * 类型常量在 @v2media/shared/protocol。
 */

import { EXT_SOURCE, WEB_SOURCE } from "@v2media/shared";
import type { BridgeRequest, BridgeRequestType, BridgeResponse } from "@v2media/shared";

const HANDLERS: Record<BridgeRequestType, string> = {
  PING: "SITE_PING",
  SET_AUTH: "SITE_SET_AUTH",
  SYNC_ACCOUNTS: "SITE_SYNC_ACCOUNTS",
  COLLECT_URL: "SITE_COLLECT_URL",
  RUN_PUBLISH_JOB: "SITE_RUN_PUBLISH_JOB",
};

window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.origin !== window.location.origin) return;
  const msg = ev.data as BridgeRequest | undefined;
  if (!msg || msg.source !== WEB_SOURCE || typeof msg.requestId !== "string") return;
  const bgType = HANDLERS[msg.type];
  if (!bgType) return;
  const reply = (body: Omit<BridgeResponse, "source" | "requestId">) =>
    window.postMessage(
      { source: EXT_SOURCE, requestId: msg.requestId, ...body },
      window.location.origin,
    );
  // 插件被刷新/更新后，已打开页面里的旧脚本与插件断开，调 chrome.runtime 会抛
  // "Extension context invalidated"——回一个可读错误，让页面提示刷新
  if (!chrome.runtime?.id) {
    reply({ ok: false, error: "插件已更新，请刷新本页" });
    return;
  }
  try {
    chrome.runtime.sendMessage(
      { type: bgType, ...(msg.payload as Record<string, unknown> | undefined) },
      (resp?: { ok?: boolean; data?: unknown; error?: string }) => {
        const err = chrome.runtime.lastError;
        const body: BridgeResponse = {
          source: EXT_SOURCE,
          requestId: msg.requestId,
          ok: err ? false : Boolean(resp?.ok),
          result: resp?.data,
          error: err?.message ?? resp?.error,
        };
        window.postMessage(body, window.location.origin);
      },
    );
  } catch {
    reply({ ok: false, error: "插件已更新，请刷新本页" });
  }
});
