import type { Ctx } from "../core/ctx.ts";
import { tableExists } from "../core/ctx.ts";
import { msgTableName } from "../core/names.ts";
import { extractXmlText, decompressMessage } from "../core/msg.ts";
import { fmtTime } from "../core/format.ts";

// ── 朋友圈 ──────────────────────────────────────────────────

type SnsNotif = {
  type: "like" | "comment";
  from_nickname: string;
  from_username: string;
  content: string;
  feed_id: number;
  feed_preview: string;
  feed_author: string;
  timestamp: number;
  time: string | null;
};

function xmlAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, "i");
  return re.exec(xml)?.[1] ?? null;
}

export function snsNotifications(
  ctx: Ctx,
  opts: { limit?: number; includeRead?: boolean } = {},
): SnsNotif[] {
  const db = ctx.db("sns/sns.db");
  if (!db) throw new Error("无法打开 sns.db");
  const limit = opts.limit ?? 50;
  const where = opts.includeRead ? "1=1" : "is_unread = 1";
  const rows = db
    .query<
      {
        local_id: number;
        create_time: number;
        type: number;
        feed_id: number;
        from_username: string;
        from_nickname: string;
        content: string;
      },
      [number]
    >(
      `SELECT local_id, create_time, type, feed_id, from_username, from_nickname, content
       FROM SnsMessage_tmp3 WHERE ${where} ORDER BY create_time DESC LIMIT ?1`,
    )
    .all(limit);

  const feeds = new Map<number, { author: string; preview: string }>();
  const ids = [...new Set(rows.map((r) => r.feed_id))].filter(Boolean);
  if (ids.length > 0) {
    try {
      const feedRows = db
        .query<{ tid: number; user_name: string; content: string }, []>(
          `SELECT tid, user_name, content FROM SnsTimeLine WHERE tid IN (${ids.join(",")})`,
        )
        .all();
      for (const f of feedRows) {
        const author = f.user_name || extractXmlText(f.content, "username") || "";
        const desc = extractXmlText(f.content, "contentDesc") ?? "";
        feeds.set(f.tid, { author, preview: desc.slice(0, 60) });
      }
    } catch {}
  }

  return rows.map((r) => {
    const content = (r.content ?? "").trim();
    const feed = feeds.get(r.feed_id);
    return {
      type: content.length === 0 ? "like" : "comment",
      from_nickname: r.from_nickname ?? "",
      from_username: r.from_username ?? "",
      content,
      feed_id: r.feed_id ?? 0,
      feed_preview: feed?.preview ?? "",
      feed_author: feed?.author ?? "",
      timestamp: r.create_time,
      time: fmtTime(r.create_time),
    };
  });
}

export type SnsMedia = {
  type: number | null;
  url: string | null;
  thumb: string | null;
  md5: string | null;
  key: string | null;
  token: string | null;
  enc_idx: string | null;
  width: number | null;
  height: number | null;
  total_size: number | null;
  video_md5: string | null;
  video_duration: number | null;
};

export type SnsPost = {
  tid: number;
  author: string;
  author_username: string;
  content: string;
  timestamp: number;
  time: string | null;
  location: string | null;
  media_count: number;
  media: SnsMedia[];
};

function parseMedia(block: string): SnsMedia {
  const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);
  return {
    type: num(extractXmlText(block, "type")),
    url: extractXmlText(block, "url"),
    thumb: extractXmlText(block, "thumb"),
    md5: xmlAttr(block, "url", "md5"),
    key: xmlAttr(block, "url", "key"),
    token: xmlAttr(block, "url", "token"),
    enc_idx: xmlAttr(block, "url", "enc_idx"),
    width: num(xmlAttr(block, "size", "width")),
    height: num(xmlAttr(block, "size", "height")),
    total_size: num(xmlAttr(block, "size", "totalSize")),
    video_md5: extractXmlText(block, "videomd5"),
    video_duration: num(extractXmlText(block, "videoDuration")),
  };
}

function parsePost(tid: number, userName: string, xml: string): SnsPost {
  const createTime = Number(extractXmlText(xml, "createTime") ?? 0);
  const author = userName || extractXmlText(xml, "username") || "";
  const nickname = extractXmlText(xml, "nickname") ?? author;
  const desc = extractXmlText(xml, "contentDesc") ?? "";
  const location = extractXmlText(xml, "poiName");
  const mediaBlocks = [...xml.matchAll(/<media>([\s\S]*?)<\/media>/g)].map((m) => m[1]!);
  return {
    tid,
    author: nickname || author,
    author_username: author,
    content: desc,
    timestamp: createTime,
    time: fmtTime(createTime),
    location: location || null,
    media_count: mediaBlocks.length,
    media: mediaBlocks.map(parseMedia),
  };
}

export function snsFeed(
  ctx: Ctx,
  opts: { limit?: number; user?: string; since?: number; until?: number } = {},
): SnsPost[] {
  const db = ctx.db("sns/sns.db");
  if (!db) throw new Error("无法打开 sns.db");
  const rows = db
    .query<{ tid: number; user_name: string; content: string }, []>(
      "SELECT tid, user_name, content FROM SnsTimeLine ORDER BY tid DESC",
    )
    .all();
  const posts = rows.map((r) => parsePost(r.tid, r.user_name ?? "", r.content ?? ""));
  const filtered = posts.filter((p) => {
    if (opts.since && p.timestamp < opts.since) return false;
    if (opts.until && p.timestamp > opts.until) return false;
    if (opts.user && ![p.author, p.author_username].some((v) => v.includes(opts.user!)))
      return false;
    return true;
  });
  return filtered.slice(0, opts.limit ?? 20);
}

export function snsSearch(ctx: Ctx, keyword: string, opts: Parameters<typeof snsFeed>[1] = {}) {
  return snsFeed(ctx, { ...opts, limit: opts?.limit ?? 100 }).filter(
    (p) => p.content.includes(keyword) || p.author.includes(keyword),
  );
}

// ── 公众号 ─────────────────────────────────────────────────

export type BizArticle = {
  account: string;
  account_username: string;
  title: string;
  url: string | null;
  digest: string | null;
  cover_url: string | null;
  timestamp: number;
  time: string | null;
};

function parseBizItems(xml: string): { title: string; url: string | null; digest: string | null; cover: string | null }[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
  const out: { title: string; url: string | null; digest: string | null; cover: string | null }[] = [];
  for (const item of items) {
    const title = extractXmlText(item, "title") ?? "";
    const url = extractXmlText(item, "url");
    if (!title && !url) continue;
    out.push({
      title,
      url: url || null,
      digest: extractXmlText(item, "digest"),
      cover: extractXmlText(item, "cover"),
    });
  }
  return out;
}

export function bizArticles(
  ctx: Ctx,
  opts: { limit?: number; account?: string; since?: number; until?: number; unreadOnly?: boolean } = {},
): BizArticle[] {
  const out: BizArticle[] = [];
  const limit = opts.limit ?? 50;
  for (const d of ctx.dbs) {
    const m = /^message\/biz_message_(\d+)\.db$/.exec(d.rel);
    if (!m) continue;
    const db = ctx.db(d.rel);
    if (!db) continue;
    const accounts = tableExists(db, "Name2Id")
      ? db
          .query<{ user_name: string }, []>(
            "SELECT DISTINCT user_name FROM Name2Id WHERE user_name IS NOT NULL AND user_name != ''",
          )
          .all()
          .map((r) => r.user_name)
      : [];
    for (const username of accounts) {
      const display = ctx.names.display(username);
      if (opts.account && !display.includes(opts.account) && !username.includes(opts.account))
        continue;
      const table = msgTableName(username);
      if (!tableExists(db, table)) continue;
      const rows = db
        .query<
          {
            create_time: number;
            message_content: Uint8Array | string | null;
            WCDB_CT_message_content: number;
          },
          []
        >(
          `SELECT create_time, message_content, WCDB_CT_message_content FROM [${table}]
           WHERE (local_type & 4294967295) = 49 ORDER BY create_time DESC LIMIT ${limit}`,
        )
        .all();
      for (const r of rows) {
        if (opts.since && r.create_time < opts.since) continue;
        if (opts.until && r.create_time > opts.until) continue;
        const xml = decompressMessage(r.message_content, r.WCDB_CT_message_content ?? 0);
        for (const item of parseBizItems(xml)) {
          out.push({
            account: display,
            account_username: username,
            title: item.title,
            url: item.url,
            digest: item.digest,
            cover_url: item.cover,
            timestamp: r.create_time,
            time: fmtTime(r.create_time),
          });
        }
      }
    }
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out.slice(0, limit);
}

// ── 收藏 ───────────────────────────────────────────────────

const FAV_TYPES: Record<number, string> = {
  1: "text",
  2: "image",
  5: "article",
  19: "card",
  20: "video",
};

export function favorites(
  ctx: Ctx,
  opts: { limit?: number; type?: string; query?: string } = {},
) {
  const db = ctx.db("favorite/favorite.db");
  if (!db) throw new Error("无法打开 favorite.db");
  const limit = opts.limit ?? 100;
  let rows: {
    local_id: number;
    type: number;
    update_time: number;
    content: string;
    fromusr: string;
    realchatname: string;
  }[] = [];
  try {
    rows = db
      .query<
        {
          local_id: number;
          type: number;
          update_time: number;
          content: string;
          fromusr: string;
          realchatname: string;
        },
        [number]
      >(
        `SELECT local_id, type, update_time, content, fromusr, realchatname
         FROM fav_db_item ORDER BY update_time DESC LIMIT ?1`,
      )
      .all(limit);
  } catch {
    return [];
  }
  return rows
    .map((r) => {
      const ts = r.update_time > 9_999_999_999 ? Math.floor(r.update_time / 1000) : r.update_time;
      const type = FAV_TYPES[r.type] ?? `type_${r.type}`;
      return {
        local_id: r.local_id,
        type,
        type_id: r.type,
        timestamp: ts,
        time: fmtTime(ts),
        content: r.content ?? "",
        from_user: r.fromusr ?? "",
        from_chat: r.realchatname ?? "",
      };
    })
    .filter((r) => (opts.type ? r.type === opts.type : true))
    .filter((r) => (opts.query ? r.content.includes(opts.query) : true));
}
