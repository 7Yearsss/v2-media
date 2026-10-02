import type { CollectionAnalysis, TopicCreateRequest } from "@v2media/shared";

/** Keep the report's identity and writing target together throughout the creation flow. */
export function topicFromAnalysis(analysis: CollectionAnalysis, ideaIndex: number): TopicCreateRequest {
  const idea = analysis.data.insight?.ideas?.[ideaIndex];
  if (analysis.status !== "done" || !idea || !Number.isInteger(ideaIndex) || ideaIndex < 0)
    throw new Error("分析建议尚未完成或已变化，请重新打开报告");
  return {
    title: idea.title,
    angle: `${idea.hook}\n${idea.angle}`,
    collectionId: analysis.collectionId,
    sourceNoteId: idea.refs?.[0]?.id,
    accountId: analysis.data.persona?.accountId ?? undefined,
    analysisId: analysis.id,
    analysisIdeaIndex: ideaIndex,
  };
}
