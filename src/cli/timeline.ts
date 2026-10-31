import type { Database } from "bun:sqlite";
import type { Ctx } from "../core/ctx.ts";
import { messageShards, tableExists } from "../core/ctx.ts";
import { msgTableName } from "../core/names.ts";
import { fmtTime } from "../core/format.ts";
import { id2uOf, rowToMsg, type Msg } from "./messages.ts";

export type TimelineRow = Msg & {
  chat: string;
  chat_display: string;
  chat_type: "private" | "group" | "official_account" | "folded";
};

export type TimelineOptions = {
  limit?: number;
  offset?: number;
  since?: number;
  until?: number;
  /** 只返回早于该时间的消息（向旧翻页） */
  before?: number;
  /** 只返回晚于该时间的消息（向新翻页） */
  after?: number;
  msgType?: number[];
  /** 参与合并的会话上限（按 session 最后活跃时间取） */
  sessionsCap?: number;
  /** 每个会话最多取多少条 */
  perChat?: number;
};

type SessionRow = { username: string; last_timestamp: number };

/** 表名 → 出现的所有分片（同一会话的表可能同时存在于多个分片） */
function shardIndex(ctx: Ctx): Map<string, Database[]> {
  const map = new Map<string, Database[]>();
  for (const db of messageShards(ctx)) {
    for (const { name } of db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'",
      )
      .all()) {
      const list = map.get(name);
      if (list) list.push(db);
      else map.set(name, [db]);
    }
  }
  return map;
}

function chatTypeOf(chat: string): TimelineRow["chat_type"] {
  if (chat.endsWith("@chatroom")) return "group";
  if (chat === "brandsessionholder" || chat === "@placeholder_foldgroup") return "folded";
  if (chat.startsWith("gh_") || chat.startsWith("biz_") || chat.startsWith("@"))
    return "official_account";
  return "private";
}

/** 跨会话按时间合并消息 */
export function timeline(
  ctx: Ctx,
  opts: TimelineOptions = {},
): { messages: TimelineRow[]; meta: Record<string, unknown> } {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const sessionsCap = opts.sessionsCap ?? 200;
  const perChat = opts.perChat ?? Math.min(2000, offset + limit + 20);
  const since = opts.since ?? (opts.after ? opts.after + 1 : undefined);
  const until = opts.until ?? opts.before;

  const sdb = ctx.db("session/session.db");
  if (!sdb) throw new Error("无法打开 session.db（检查密钥：wx doctor）");
  const sessions = sdb
    .query<SessionRow, [number]>(
      `SELECT username, last_timestamp FROM SessionTable
       WHERE last_timestamp > 0 ORDER BY last_timestamp DESC LIMIT ?1`,
    )
    .all(sessionsCap);
  const considered = sessions.filter((s) => !until || s.last_timestamp >= (since ?? 0));
  const shards = shardIndex(ctx);

  const typeFilter =
    opts.msgType && opts.msgType.length > 0
      ? ` AND (local_type & 4294967295) IN (${opts.msgType.join(",")})`
      : "";
  const rows: TimelineRow[] = [];
  let queried = 0;

  for (const s of considered) {
    const table = msgTableName(s.username);
    const dbs = shards.get(table);
    if (!dbs || dbs.length === 0) continue;
    queried++;
    const clauses: string[] = [];
    if (since) clauses.push(`create_time >= ${Math.floor(since)}`);
    if (until) clauses.push(`create_time <= ${Math.floor(until)}`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const isGroup = s.username.endsWith("@chatroom");
    const nicks = isGroup ? ctx.groupNicknames(s.username) : new Map<string, string>();
    const display = ctx.names.display(s.username);
    const ctype = chatTypeOf(s.username);
    for (const db of dbs) {
      if (!tableExists(db, table)) continue;
      const raw = db
        .query<
          {
            local_id: number;
            local_type: number;
            create_time: number;
            real_sender_id: number;
            message_content: Uint8Array | string | null;
            WCDB_CT_message_content: number;
          },
          []
        >(
          `SELECT local_id, local_type, create_time, real_sender_id,
                  message_content, WCDB_CT_message_content
           FROM [${table}] ${where}${typeFilter}
           ORDER BY create_time DESC LIMIT ${perChat}`,
        )
        .all();
      const id2u = id2uOf(db);
      for (const r of raw) {
        rows.push({
          ...rowToMsg(ctx, s.username, isGroup, r, id2u, nicks),
          chat: s.username,
          chat_display: display,
          chat_type: ctype,
        });
      }
    }
  }

  rows.sort((a, b) => b.timestamp - a.timestamp || b.local_id - a.local_id);
  const page = rows.slice(offset, offset + limit);
  return {
    messages: page,
    meta: {
      sessions_considered: considered.length,
      sessions_queried: queried,
      session_cap: sessionsCap,
      per_chat: perChat,
      since: since ?? null,
      until: until ?? null,
      newest: page[0]?.time ?? null,
      oldest: page[page.length - 1]?.time ?? null,
      generated_at: fmtTime(Math.floor(Date.now() / 1000)),
    },
  };
}
