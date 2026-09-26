/**
 * MAIN world 嗅探脚本（creator.xiaohongshu.com，document_start）。
 * 与 xhs.ts 同骨架：hook XHR/fetch，把 /api/galaxy/* 的 JSON 响应
 * 经 v2m:galaxy CustomEvent 透传给隔离 world（creator-tasks.ts）。
 * 不解析业务字段——原始 {url,path,httpStatus,json} 都传，解析在 shared/galaxy-parse。
 */

import { EVT_GALAXY } from "../lib/messages";

const onCreator = location.hostname === "creator.xiaohongshu.com";

declare global {
  interface Window {
    __v2m_creator_main_ready?: boolean;
  }
}

if (onCreator && !window.__v2m_creator_main_ready) {
  window.__v2m_creator_main_ready = true;

  const emit = (url: string, httpStatus: number, json: Record<string, unknown>) => {
    let path = "";
    try {
      path = new URL(url, location.href).pathname;
    } catch {
      return;
    }
    if (!path.includes("/api/galaxy/")) return;
    document.dispatchEvent(
      new CustomEvent(EVT_GALAXY, {
        detail: { url, path, httpStatus, json },
      }),
    );
  };

  const sniffText = (url: string, httpStatus: number, text: string) => {
    if (typeof text !== "string" || !text || text[0] !== "{") return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    emit(url, httpStatus, parsed);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async = true,
    user?: string | null,
    password?: string | null,
  ) {
    (this as { __v2m_url?: string }).__v2m_url = String(url || "");
    return (origOpen as any).call(this, method, url, async, user, password);
  };
  XMLHttpRequest.prototype.send = function (...args: any[]) {
    this.addEventListener("readystatechange", function () {
      if (this.readyState !== 4) return;
      const url = this.responseURL || (this as { __v2m_url?: string }).__v2m_url || "";
      try {
        sniffText(url, this.status, this.responseText);
      } catch {
        /* 非 JSON 响应 */
      }
    });
    return origSend.apply(this, args as []);
  };

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args: Parameters<typeof fetch>) {
      const first: unknown = args[0];
      const url =
        typeof first === "string" ? first : first instanceof Request ? first.url : "";
      return origFetch.apply(this, args).then((resp) => {
        resp
          .clone()
          .text()
          .then((t) => sniffText(url, resp.status, t))
          .catch(() => {});
        return resp;
      });
    };
  }
}
