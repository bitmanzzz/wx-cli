import type { Database } from "bun:sqlite";
import type { Ctx } from "../core/ctx.ts";
import { messageShards, tableExists } from "../core/ctx.ts";
import { msgTableName } from "../core/names.ts";
import { id2uOf, rowToMsg, type Msg } from "./messages.ts";

export type WatchRow = Msg & {
  chat: string;
  chat_display: string;
};

type SessionState = { last: number; unread: number };

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

/** 读当前会话状态快照 */
export function readSessions(ctx: Ctx): Map<string, SessionState> {
  const db = ctx.db("session/session.db");
  if (!db) throw new Error("无法打开 session.db（检查密钥：wx doctor）");
  const out = new Map<string, SessionState>();
  for (const r of db
    .query<{ username: string; last_timestamp: number; unread_count: number }, []>(
      "SELECT username, last_timestamp, unread_count FROM SessionTable",
    )
    .all()) {
    out.set(r.username, { last: r.last_timestamp ?? 0, unread: r.unread_count ?? 0 });
  }
  return out;
}

export type PollResult = {
  state: Map<string, SessionState>;
  rows: WatchRow[];
  changed: string[];
};

/**
 * 单次轮询：把 `prev` 与当前 session.db 对比，拉出有新消息的会话。
 * 返回新的状态与新增消息（按时间升序，便于直接打印）。
 */
export function pollOnce(
  ctx: Ctx,
  prev: Map<string, SessionState>,
  opts: { limit?: number; shards?: Map<string, Database[]> } = {},
): PollResult {
  const limit = opts.limit ?? 50;
  const now = readSessions(ctx);
  const shards = opts.shards ?? shardIndex(ctx);
  const rows: WatchRow[] = [];
  const changed: string[] = [];

  for (const [chat, cur] of now) {
    const old = prev.get(chat);
    if (old && cur.last <= old.last) continue;
    if (!old && prev.size > 0) continue; // 首次之外的「新会话」也当新消息处理
    changed.push(chat);
    const table = msgTableName(chat);
    const dbs = shards.get(table);
    if (!dbs || dbs.length === 0) continue;
    const since = old?.last ?? 0;
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
        [number, number]
      >(
        `SELECT local_id, local_type, create_time, real_sender_id,
                message_content, WCDB_CT_message_content
         FROM [${table}] WHERE create_time > ?1
         ORDER BY create_time ASC LIMIT ?2`,
      )
        .all(since, limit);
      const isGroup = chat.endsWith("@chatroom");
      const nicks = isGroup ? ctx.groupNicknames(chat) : new Map<string, string>();
      const id2u = id2uOf(db);
      const display = ctx.names.display(chat);
      for (const r of raw) {
        rows.push({ ...rowToMsg(ctx, chat, isGroup, r, id2u, nicks), chat, chat_display: display });
      }
    }
  }

  rows.sort((a, b) => a.timestamp - b.timestamp || a.local_id - b.local_id);
  return { state: now, rows, changed };
}

/** 持续轮询；每行输出一条 JSON（NDJSON），Ctrl-C 退出 */
export async function watchLoop(
  ctx: Ctx,
  opts: { interval?: number; limit?: number; since?: number } = {},
): Promise<void> {
  const interval = Math.max(300, opts.interval ?? 1500);
  const shards = shardIndex(ctx);
  let state = readSessions(ctx);

  // 可选：先补一次历史（只在给了 --since 时）
  if (opts.since) {
    const { rows } = pollOnce(
      ctx,
      new Map([...state].map(([k, v]) => [k, { last: opts.since! - 1, unread: v.unread }])),
      { limit: opts.limit, shards },
    );
    for (const r of rows) console.log(JSON.stringify(r));
  }

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (running) {
    await Bun.sleep(interval);
    let polled;
    try {
      polled = pollOnce(ctx, state, { limit: opts.limit, shards });
    } catch (e) {
      console.error(`轮询失败：${(e as Error).message}`);
      continue;
    }
    state = polled.state;
    for (const r of polled.rows) console.log(JSON.stringify(r));
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
