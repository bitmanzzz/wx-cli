import { join } from "node:path";
import { CONFIG_DIR, readJson, writeJsonPrivate } from "../util.ts";
import type { Ctx } from "../core/ctx.ts";
import { messageShards, tableExists } from "../core/ctx.ts";
import { decompressMessage, fmtContent, fmtType, typeId } from "../core/msg.ts";
import { fmtTime } from "../core/format.ts";

const STATE_PATH = join(CONFIG_DIR, "watch-state.json");
type State = { last_check: number; last_seen: Record<string, number> };

export function loadState(): State {
  return readJson<State>(STATE_PATH) ?? { last_check: 0, last_seen: {} };
}

export function saveState(s: State) {
  writeJsonPrivate(STATE_PATH, s);
}

/** 上次检查之后的新消息（首次运行只看最近 1 小时） */
export function newMessages(ctx: Ctx, opts: { limit?: number; update?: boolean } = {}) {
  const state = loadState();
  const since = state.last_check > 0 ? state.last_check : Math.floor(Date.now() / 1000) - 3600;
  const fresh: {
    chat: string;
    display: string;
    chat_type: string;
    timestamp: number;
    time: string | null;
    sender: string;
    content: string;
    type: string;
    type_id: string;
    local_id: number;
  }[] = [];

  for (const db of messageShards(ctx)) {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'",
      )
      .all();
    for (const { name } of tables) {
      const chat = ctx.names.usernameOfMd5(name.slice(4)) ?? name;
      if (!tableExists(db, name)) continue;
      const rows = db
        .query<
          {
            local_id: number;
            local_type: number;
            create_time: number;
            real_sender_id: number;
            message_content: Uint8Array | string | null;
            WCDB_CT_message_content: number;
          },
          [number]
        >(
          `SELECT local_id, local_type, create_time, real_sender_id,
                  message_content, WCDB_CT_message_content
           FROM [${name}] WHERE create_time > ?1 ORDER BY create_time DESC LIMIT 500`,
        )
        .all(since);
      for (const r of rows) {
        const content = decompressMessage(r.message_content, r.WCDB_CT_message_content ?? 0);
        fresh.push({
          chat,
          display: ctx.names.display(chat),
          chat_type: chat.endsWith("@chatroom") ? "group" : "private",
          timestamp: r.create_time,
          time: fmtTime(r.create_time),
          sender: "",
          content: fmtContent(r.local_id, r.local_type, content, chat.endsWith("@chatroom")),
          type: fmtType(r.local_type),
          type_id: typeId(r.local_type),
          local_id: r.local_id,
        });
      }
    }
  }

  fresh.sort((a, b) => b.timestamp - a.timestamp);
  const limited = fresh.slice(0, opts.limit ?? 100);
  if (opts.update !== false) {
    const now = Math.floor(Date.now() / 1000);
    const next: State = { last_check: now, last_seen: {} };
    saveState(next);
  }
  return { since, count: limited.length, messages: limited, unknown_shards: ctx.unknownShards() };
}

