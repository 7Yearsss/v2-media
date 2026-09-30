/** Product-defined automatic collection threshold, not a platform ranking score. */
export interface HotFilter {
  enabled: boolean;
  minLikes: number;
}

export function normalizeHotFilter(value?: Partial<HotFilter>): HotFilter {
  const minLikes = value?.minLikes;
  return {
    enabled: value?.enabled === true,
    minLikes: typeof minLikes === "number" && Number.isSafeInteger(minLikes) && minLikes >= 0
      ? minLikes : 1000,
  };
}

export function passesHotFilter(likes: number, filter?: Partial<HotFilter>): boolean {
  const rule = normalizeHotFilter(filter);
  return !rule.enabled || (Number.isFinite(likes) && likes >= rule.minLikes);
}
