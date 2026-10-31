/** 时间格式化：秒级 epoch → 本地时间字符串 */
export function fmtTime(sec: number | null | undefined): string | null {
  if (!sec || sec <= 0) return null;
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 解析 --since / --until：支持 2026-01-01 / 2026-01-01 12:00 / YYYY-MM-DDTHH:mm:ss */
export function parseTimeArg(s: string | undefined, endOfDay = false): number | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s.trim());
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  const [, y, mo, d, h, mi, se] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    h ? Number(h) : endOfDay ? 23 : 0,
    mi ? Number(mi) : endOfDay ? 59 : 0,
    se ? Number(se) : endOfDay ? 59 : 0,
  );
  return Math.floor(date.getTime() / 1000);
}

export type ChatType = "private" | "group" | "official_account" | "folded";

/** 4.x：群聊 username 以 @chatroom 结尾；公众号为 gh_ 前缀 */
export function chatTypeOf(username: string): ChatType {
  if (username.endsWith("@chatroom")) return "group";
  if (username.startsWith("gh_")) return "official_account";
  if (username === "brandsessionholder" || username === "brandsessionholder_weapp") return "folded";
  return "private";
}
