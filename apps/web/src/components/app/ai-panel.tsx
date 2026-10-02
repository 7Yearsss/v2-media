import { Check, Hash, ListPlus, PenLine, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Draft } from "@v2media/shared";
import { PromptInput } from "@/components/agents/prompt-input";
import { StreamingResponse } from "@/components/agents/streaming-response";
import { Button } from "@/components/motion/button";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type RunKind = "rewrite" | "titles" | "tags";

interface AiRun {
  id: number;
  kind: RunKind;
  label: string;
  status: "streaming" | "complete" | "error";
  /** 流式展示的目标全文（标题===正文 格式）。 */
  fullText: string;
  error?: string;
  titles?: string[];
  tags?: string[];
}

/** 打字机式逐段 reveal，让一次性返回的 REST 结果也有流式观感。 */
function useReveal(target: string, active: boolean): string {
  const [shown, setShown] = useState(active ? "" : target);
  useEffect(() => {
    if (!active) {
      setShown(target);
      return;
    }
    setShown("");
    let i = 0;
    const t = window.setInterval(() => {
      i += 6;
      if (i >= target.length) {
        setShown(target);
        window.clearInterval(t);
      } else {
        setShown(target.slice(0, i));
      }
    }, 16);
    return () => window.clearInterval(t);
  }, [target, active]);
  return shown;
}

function RewriteResult({
  run,
  onApply,
}: {
  run: AiRun;
  onApply: (title: string, content: string) => void;
}) {
  const shown = useReveal(run.fullText, run.status === "streaming");
  return (
    <div className="space-y-2">
      <StreamingResponse
        status={run.status === "error" ? "error" : run.status}
        copyText={run.fullText}
        className="text-[13px] leading-6"
      >
        {run.status === "error" ? run.error : shown}
      </StreamingResponse>
      {run.status === "complete" ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const [title, ...rest] = run.fullText.split("\n===\n");
            onApply(title ?? "", rest.join("\n===\n"));
          }}
        >
          <Check className="size-3.5" />
          应用标题+正文
        </Button>
      ) : null}
    </div>
  );
}

export function AiPanel({
  draft,
  title,
  content,
  onApplyRewrite,
  onApplyTitle,
  onApplyTags,
}: {
  draft: Draft | null;
  title: string;
  content: string;
  onApplyRewrite: (title: string, content: string) => void;
  onApplyTitle: (title: string) => void;
  onApplyTags: (tags: string[]) => void;
}) {
  const toast = useToast();
  const [runs, setRuns] = useState<AiRun[]>([]);
  const [prompt, setPrompt] = useState("");
  const idRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const context = `${draft?.id ?? "none"}:${draft?.accountId ?? "generic"}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => { setRuns([]); }, [context]);

  const pushRun = (kind: RunKind, label: string): number => {
    const id = ++idRef.current;
    setRuns((cur) => [
      ...cur,
      { id, kind, label, status: "streaming", fullText: "" },
    ]);
    return id;
  };

  const patchRun = (id: number, patch: Partial<AiRun>) =>
    setRuns((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const guardEmpty = () => {
    if (!title.trim() && !content.trim()) {
      toast.info("先写点标题或正文再调用 AI");
      return true;
    }
    return false;
  };

  const startRewrite = async (instruction?: string) => {
    if (guardEmpty() || busy) return;
    const id = pushRun("rewrite", instruction ? "自定义改写" : "AI 改写正文");
    const startedIn = contextRef.current;
    setBusy(true);
    try {
      const res = await api.aiRewrite({
        draftId: draft?.id,
        accountId: draft?.accountId,
        title,
        content,
        instruction,
      });
      if (contextRef.current !== startedIn) return;
      patchRun(id, {
        status: "streaming",
        fullText: `${res.title}\n===\n${res.content}`,
      });
      // 先让 useReveal 逐字展示，再标记 complete（揭示动作按钮）
      window.setTimeout(
        () => patchRun(id, { status: "complete" }),
        Math.min(2800, res.content.length * 3 + 300),
      );
    } catch (err) {
      patchRun(id, {
        status: "error",
        error: err instanceof Error ? err.message : "改写失败",
      });
    } finally {
      setBusy(false);
    }
  };

  const startTitles = async () => {
    if (guardEmpty() || busy) return;
    const id = pushRun("titles", "生成 5 个标题");
    const startedIn = contextRef.current;
    setBusy(true);
    try {
      const res = await api.aiTitles({ draftId: draft?.id, accountId: draft?.accountId, title, content, count: 5 });
      if (contextRef.current !== startedIn) return;
      patchRun(id, { status: "complete", titles: res.titles });
    } catch (err) {
      patchRun(id, {
        status: "error",
        error: err instanceof Error ? err.message : "生成标题失败",
      });
    } finally {
      setBusy(false);
    }
  };

  const startTags = async () => {
    if (guardEmpty() || busy) return;
    const id = pushRun("tags", "生成话题标签");
    const startedIn = contextRef.current;
    setBusy(true);
    try {
      const res = await api.aiTags({ draftId: draft?.id, accountId: draft?.accountId, title, content, count: 8 });
      if (contextRef.current !== startedIn) return;
      patchRun(id, { status: "complete", tags: res.tags });
    } catch (err) {
      patchRun(id, {
        status: "error",
        error: err instanceof Error ? err.message : "生成标签失败",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-3xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-primary" />
        <p className="text-sm font-semibold text-foreground">AI 助手</p>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void startRewrite()}
        >
          <PenLine className="size-3.5" />
          AI 改写正文
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void startTitles()}
        >
          <ListPlus className="size-3.5" />
          生成 5 个标题
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void startTags()}
        >
          <Hash className="size-3.5" />
          话题标签
        </Button>
      </div>

      {runs.length > 0 ? (
        <div className="mb-3 max-h-72 space-y-3 overflow-y-auto pr-1">
          {runs.map((run) => (
            <div
              key={run.id}
              className="rounded-2xl border border-border bg-muted/40 p-3"
            >
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {run.label}
              </p>
              {run.kind === "rewrite" ? (
                <RewriteResult run={run} onApply={onApplyRewrite} />
              ) : run.status === "error" ? (
                <p className="text-[13px] text-destructive">{run.error}</p>
              ) : run.status === "streaming" ? (
                <StreamingResponse status="streaming">
                  正在生成…
                </StreamingResponse>
              ) : run.kind === "titles" ? (
                <ul className="space-y-1.5">
                  {(run.titles ?? []).map((t, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => {
                          onApplyTitle(t);
                          toast.success("已应用为标题");
                        }}
                        className={cn(
                          "w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-5 text-foreground",
                          "outline-none transition-colors hover:bg-card focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                      >
                        {t}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  {(run.tags ?? []).map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary"
                    >
                      #{t}
                    </span>
                  ))}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onApplyTags(run.tags ?? []);
                      toast.success("已追加到标签");
                    }}
                  >
                    <Check className="size-3.5" />
                    全部应用
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          用快捷指令一键改写/起标题/生成话题，或在下方输入自定义改写要求。
        </p>
      )}

      <PromptInput
        value={prompt}
        onValueChange={setPrompt}
        placeholder="对正文的改写要求，回车发送…"
        minRows={2}
        maxRows={5}
        loading={busy}
        onSubmit={(value) => {
          const instruction = value.trim();
          if (!instruction) return;
          setPrompt("");
          void startRewrite(instruction);
        }}
      />
    </div>
  );
}
