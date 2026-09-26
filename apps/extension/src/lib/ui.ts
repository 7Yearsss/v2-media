/** Shadow DOM 浮层共用的小工具（content / creator-publish 都用）。 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "class") node.className = String(v);
    else if (k.startsWith("on")) (node as unknown as Record<string, unknown>)[k.toLowerCase()] = v;
    else if (k in node) (node as unknown as Record<string, unknown>)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

/** 挂一个挂到 documentElement 的 shadow host；重复调用返回同一个。 */
export function shadowHost(id: string): { host: HTMLElement; shadow: ShadowRoot } {
  let host = document.getElementById(id);
  if (!host) {
    host = el("div", { id });
    document.documentElement.append(host);
  }
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  return { host, shadow };
}

const TOAST_CSS = `
.toast { position: fixed; top: 72px; right: 16px; z-index: 2147483001; max-width: 320px;
  padding: 10px 14px; border-radius: 8px; color: #fff; font: 13px/1.5 system-ui, sans-serif;
  box-shadow: 0 4px 14px rgba(0,0,0,.25); background: #16a34a; }
.toast.err { background: #dc2626; }
`;

export function toastIn(shadow: ShadowRoot, msg: string, ok = true) {
  let wrap = shadow.querySelector<HTMLElement>(".v2m-toast-wrap");
  if (!wrap) {
    shadow.append(el("style", {}, TOAST_CSS));
    wrap = el("div", { class: "v2m-toast-wrap" });
    shadow.append(wrap);
  }
  const t = el("div", { class: `toast${ok ? "" : " err"}` }, msg);
  wrap.append(t);
  setTimeout(() => t.remove(), ok ? 2600 : 5000);
}
