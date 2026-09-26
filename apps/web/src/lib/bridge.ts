/**
 * 工作台页面 <-> 浏览器插件 的 postMessage 桥（同源校验）。
 * 协议常量与载荷类型来自 @v2media/shared/protocol。
 */
import { useEffect, useState } from "react";
import {
  EXT_SOURCE,
  WEB_SOURCE,
  type BridgeRequest,
  type BridgeRequestType,
  type BridgeResponse,
  type CollectUrlPayload,
  type RunPublishJobPayload,
  type SetAuthPayload,
} from "@v2media/shared";

function rid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function send<TRes = unknown, TReq = unknown>(
  type: BridgeRequestType,
  payload?: TReq,
  timeoutMs = 4000,
): Promise<TRes> {
  return new Promise<TRes>((resolve, reject) => {
    const requestId = rid();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      fn();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<BridgeResponse<TRes>> | undefined;
      if (!data || data.source !== EXT_SOURCE || data.requestId !== requestId)
        return;
      finish(() => {
        if (data.ok) resolve(data.result as TRes);
        else reject(new Error(data.error || "插件返回错误"));
      });
    };

    const timer = window.setTimeout(() => {
      finish(() => reject(new Error("插件无响应（未安装或未注入）")));
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    const message: BridgeRequest<TReq> = {
      source: WEB_SOURCE,
      type,
      requestId,
      payload,
    };
    window.postMessage(message, window.location.origin);
  });
}

export const bridge = {
  /** 插件是否在线。超时/异常一律视为离线。 */
  async ping(timeoutMs = 2000): Promise<boolean> {
    try {
      await send("PING", undefined, timeoutMs);
      return true;
    } catch {
      return false;
    }
  },
  /** 「授权插件」：把 apiBase + token 写入插件 storage。 */
  setAuth: (payload: SetAuthPayload) =>
    send<{ ok?: boolean }, SetAuthPayload>("SET_AUTH", payload),
  /** 让插件立即上报当前浏览器登录的小红书账号。 */
  syncAccounts: () => send<{ synced?: number }>("SYNC_ACCOUNTS"),
  /** 让插件打开并采集某条笔记详情页。 */
  collectUrl: (url: string) =>
    send<unknown, CollectUrlPayload>("COLLECT_URL", { url }),
  /** 立即执行一个发布任务。 */
  runPublishJob: (jobId: number) =>
    send<unknown, RunPublishJobPayload>("RUN_PUBLISH_JOB", { jobId }),
};

/** 周期性 PING 插件；首次结果为 null 表示检测中。 */
export function useExtensionOnline(intervalMs = 12_000): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const ok = await bridge.ping();
      if (alive) setOnline(ok);
    };
    void check();
    const t = window.setInterval(check, intervalMs);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [intervalMs]);
  return online;
}
