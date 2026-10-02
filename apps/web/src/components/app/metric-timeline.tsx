/** Absolute values on a real time axis. Nulls break the line, including zero-valued samples. */
export function MetricTimeline({ points, label }: { points: Array<{ capturedAt: string; value: number | null }>; label: string }) {
  const known = points.filter(p => p.value !== null);
  if (!known.length) return <p className="py-8 text-center text-xs text-muted-foreground">{label}未采到</p>;
  const times = points.map(p => Date.parse(p.capturedAt)), first = Math.min(...times), last = Math.max(...times);
  const max = Math.max(1, ...known.map(p => p.value!));
  const x = (i: number) => first === last ? 300 : 32 + (times[i]! - first) / (last - first) * 536;
  const y = (v: number) => 115 - v / max * 85;
  const segments: string[] = []; let segment = "";
  points.forEach((p, i) => { if (p.value === null) { if (segment) segments.push(segment); segment = ""; }
    else segment += `${segment ? " L" : "M"}${x(i)},${y(p.value)}`; });
  if (segment) segments.push(segment);
  return <div className="space-y-1">
    <svg viewBox="0 0 600 150" role="img" aria-label={`${label}，${points.length} 次真实采样`} className="w-full text-primary">
      <line x1="32" y1="115" x2="568" y2="115" className="stroke-border" />
      <text x="4" y="34" className="fill-muted-foreground text-[10px]">{max}</text><text x="12" y="118" className="fill-muted-foreground text-[10px]">0</text>
      {segments.map((d, i) => <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth="2" />)}
      {points.map((p, i) => p.value === null ? null : <circle key={i} cx={x(i)} cy={y(p.value)} r="3.5" fill="currentColor"><title>{new Date(p.capturedAt).toLocaleString()}：{p.value}</title></circle>)}
      <text x="32" y="140" className="fill-muted-foreground text-[10px]">{new Date(first).toLocaleString()}</text>
      {first !== last && <text x="568" y="140" textAnchor="end" className="fill-muted-foreground text-[10px]">{new Date(last).toLocaleString()}</text>}
    </svg>
    <p className="text-xs text-muted-foreground">{label}；缺失采样不连线，悬停查看时间与数值。</p>
  </div>;
}
