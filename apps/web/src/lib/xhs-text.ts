/** 小红书文本里的表情码（如 `[笑哭R]`）→ emoji；没有对应的保留为 `[名称]`，去掉末尾的 R。 */
const EMOJI: Record<string, string> = {
  笑哭: "😂", 飙泪笑: "🤣", 大笑: "😆", 偷笑: "🤭", 哭惹: "😭", 大哭: "😭", 赞: "👍", 皱眉: "😣",
  害羞: "😳", 色: "😍", 飞吻: "😘", 亲亲: "😚", 汗颜: "😅", 吃瓜: "🍉", 石化: "🗿", 酷: "😎",
  发怒: "😡", 生气: "😠", 惊恐: "😱", 可怜: "🥺", 叹气: "😮‍💨", 握手: "🤝", 抱抱: "🤗", 比心: "🫰",
  拜托: "🙏", 暗中观察: "👀", 捂脸: "🤦", 思考: "🤔", 庆祝: "🎉", 爱心: "❤️", 心碎: "💔", 红包: "🧧",
  鼓掌: "👏", 加油: "💪", OK: "👌", 微笑: "🙂", 无语: "😑", 晕: "😵", 睡: "😴", 再见: "👋",
  困: "🥱", 汗: "💦", 翻白眼: "🙄", 得意: "😏", 淡然: "😌", 笑: "😄", 哭: "😢", doge: "🐶",
  喜欢: "🥰", 耶: "✌️", 尬笑: "😬", 流汗: "😓", 打脸: "🤕", 偷看: "🫣", 抱拳: "🙏",
};

const CODE = /\[([^\[\]\s]{1,8}?)R?\]/g;

export function xhsEmoji(text: string): string {
  return text.replace(CODE, (whole, name: string) => EMOJI[name] ?? (whole.endsWith("R]") ? `[${name}]` : whole));
}

/** 评论时间：当年显示 MM-DD，往年显示 YYYY-MM-DD。 */
export function commentDate(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() === new Date().getFullYear() ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}
