import type { Deps } from "../context";
import { createAnalysisAiRunHandler } from "./analysis-ai-run";
import { createTopicAiRunHandlers } from "./topic-ai-run";
import type { AiRunHandlers } from "./ai-runs";

export function createAiRunHandlers(deps: Deps): AiRunHandlers {
  return { analysis: createAnalysisAiRunHandler(deps), ...createTopicAiRunHandlers(deps) };
}
