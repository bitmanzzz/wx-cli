import type { Database } from "bun:sqlite";
import type { Ctx } from "../core/ctx.ts";
import { messageShards, resolveChat, tableExists } from "../core/ctx.ts";
import {
  decompressMessage,
  fmtContent,
  fmtType,
  parseAppmsg,
  stripGroupPrefix,
  typeCode,
  typeId,
} from "../core/msg.ts";
import { msgTableName } from "../core/names.ts";
import { fmtTime } from "../core/format.ts";

export type Msg = {
  timestamp: number;
  time: string | null;
  sender: string;
  content: string;
  type: string;
  type_id: string;
  type_code: number;
  local_id: number;
  appmsg_type?: number;
  url?: string | null;
  sender_username?: string;
  sender_contact_display?: string;
  sender_group_nickname?: string;
};

export type ListOptions = {
  limit?: number;
  offset?: number;
  since?: number;
  until?: number;
  msgType?: string;
};

const TYPE_FILTER: Record<string, number[]> = {
  text: [1],
  image: [3],
  voice: [34],
  video: [43],
  link: [49],
  file: [49],
  appmsg: [49],
  system: [10000],
};

function id2uOf(db: Database): Map<number, string> {
  const out = new Map<number, string>();
  if (!tableExists(db, "Name2Id")) return out;
  try {
    for (const r of db
      .query<{ rowid: number; user_name: string }, []>("SELECT rowid, user_name FROM Name2Id")
      .all()) {
      if (r.user_name) out.set(r.rowid, r.user_name);
    }
  } catch {}
  return out;
}

function senderOf(
  ctx: Ctx,
  chat: string,
  isGroup: boolean,
  realSenderId: number,
  content: string,
  id2u: Map<number, string>,
  nicks: Map<string, string>,
): { label: string; username?: string; contact?: string; nick?: string } {
  const uname = id2u.get(realSenderId) ?? "";
  let username = uname;
  if (!username && isGroup && content.includes(":\n")) {
    const prefix = content.split(":\n")[0] ?? "";
    if (prefix && !prefix.includes(" ")) username = prefix;
  }
  if (!username || username === chat) return { label: "" };
  const contact = ctx.names.contactDisplay(username);
  const nick = nicks.get(username) ?? "";
  return {
    label: isGroup ? nick || contact || username : contact || username,
    username,
    contact,
    nick,
  };
}

function rowToMsg(
  ctx: Ctx,
  chat: string,
  isGroup: boolean,
  row: {
    local_id: number;
    local_type: number;
    create_time: number;
    real_sender_id: number;
    message_content: Uint8Array | string | null;
    WCDB_CT_message_content: number;
  },
  id2u: Map<number, string>,
  nicks: Map<string, string>,
): Msg {
  const content = decompressMessage(row.message_content, row.WCDB_CT_message_content ?? 0);
  const s = senderOf(ctx, chat, isGroup, row.real_sender_id, content, id2u, nicks);
  const text = fmtContent(row.local_id, row.local_type, content, isGroup);
  const appmsg = typeCode(row.local_type) === 49 ? parseAppmsg(stripGroupPrefix(content)) : null;
  const msg: Msg = {
    timestamp: row.create_time,
    time: fmtTime(row.create_time),
    sender: s.label,
    content: text,
    type: fmtType(row.local_type),
    type_id: typeId(row.local_type),
    type_code: typeCode(row.local_type),
    local_id: row.local_id,
  };
  if (appmsg?.type) msg.appmsg_type = appmsg.type;
  if (appmsg?.url) msg.url = appmsg.url;
  if (s.username) {
    msg.sender_username = s.username;
    msg.sender_contact_display = s.contact;
    msg.sender_group_nickname = s.nick;
  }
  return msg;
}

/** 跨分片拉取某会话的消息（按时间倒序取，最终按时间正序返回） */
export function listMessages(
  ctx: Ctx,
  chatQuery: string,
  opts: ListOptions = {},
): {
  chat: string;
  display: string;
  chat_type: string;
  messages: Msg[];
  chat_latest_timestamp: number | null;
  chat_latest_db: string | null;
} {
  const resolved = resolveChat(ctx, chatQuery);
  if (!resolved) throw new Error(`找不到会话: ${chatQuery}`);
  const chat = resolved.username;
  const isGroup = chat.endsWith("@chatroom");
  const nicks = isGroup ? ctx.groupNicknames(chat) : new Map<string, string>();
  const table = msgTableName(chat);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const wanted = opts.msgType ? (TYPE_FILTER[opts.msgType] ?? []) : [];
  const clauses: string[] = [];
  if (opts.since) clauses.push(`create_time >= ${Math.floor(opts.since)}`);
  if (opts.until) clauses.push(`create_time <= ${Math.floor(opts.until)}`);
  if (wanted.length > 0) {
    clauses.push(`(local_type & 4294967295) IN (${wanted.join(",")})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const all: Msg[] = [];
  let latestTs = 0;
  let latestDb: string | null = null;
  for (const db of messageShards(ctx)) {
    if (!tableExists(db, table)) continue;
    const id2u = id2uOf(db);
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
        []
      >(
        `SELECT local_id, local_type, create_time, real_sender_id,
                message_content, WCDB_CT_message_content
         FROM [${table}] ${where} ORDER BY create_time DESC LIMIT ${limit + offset}`,
      )
      .all();
    for (const r of rows) {
      all.push(rowToMsg(ctx, chat, isGroup, r, id2u, nicks));
      if (r.create_time > latestTs) {
        latestTs = r.create_time;
        latestDb = db.filename?.split("/").slice(-2).join("/") ?? null;
      }
    }
  }

  all.sort((a, b) => b.timestamp - a.timestamp || b.local_id - a.local_id);
  const page = all.slice(offset, offset + limit).sort((a, b) => a.timestamp - b.timestamp || a.local_id - b.local_id);
  return {
    chat,
    display: resolved.display,
    chat_type: chat.endsWith("@chatroom") ? "group" : "private",
    messages: page,
    chat_latest_timestamp: latestTs || null,
    chat_latest_db: latestDb,
  };
}

export type SearchHit = Msg & { chat: string; chat_display: string };

/** 关键词搜索：优先 message_fts.db 的 content 表，其次逐分片 LIKE */
export function searchMessages(
  ctx: Ctx,
  keyword: string,
  opts: ListOptions & { inChat?: string } = {},
): { hits: SearchHit[]; source: string } {
  const limit = opts.limit ?? 100;
  const pattern = `%${keyword}%`;
  const hits: SearchHit[] = [];
  // --in 允许传备注名/昵称，统一解析成 username
  let inChat = opts.inChat;
  if (inChat) {
    try {
      inChat = resolveChat(ctx, inChat)?.username ?? inChat;
    } catch {
      // 名字不唯一时保留原样，交给下面的比较逻辑
    }
  }

  const fts = ctx.db("message/message_fts.db");
  let source = "shards";
  if (fts) {
    const tables = fts
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_content'",
      )
      .all()
      .map((r) => r.name);
    if (tables.length > 0) {
      source = "message_fts";
      const sessionIdToChat = new Map<number, string>();
      try {
        for (const r of fts
          .query<{ rowid: number; username: string }, []>("SELECT rowid, username FROM name2id")
          .all())
          if (r.username) sessionIdToChat.set(r.rowid, r.username);
      } catch {}
      for (const t of tables) {
        const rows = fts
          .query<
            { c0: string | null; c1: number; c3: number; c4: number; c5: number; c6: number },
            [string]
          >(`SELECT c0, c1, c3, c4, c5, c6 FROM [${t}] WHERE c0 LIKE ?1 LIMIT ${limit}`)
          .all(pattern);
        for (const r of rows) {
          if (opts.since && r.c6 < opts.since) continue;
          if (opts.until && r.c6 > opts.until) continue;
          const chat = sessionIdToChat.get(r.c4) ?? "";
          if (inChat && chat !== inChat) continue;
          hits.push({
            timestamp: r.c6,
            time: fmtTime(r.c6),
            sender: "",
            content: r.c0 ?? "",
            type: fmtType(r.c3 ?? 0),
            type_id: typeId(r.c3 ?? 0),
            type_code: typeCode(r.c3 ?? 0),
            local_id: r.c1 ?? 0,
            chat,
            chat_display: chat ? ctx.names.display(chat) : "",
          });
        }
      }
    }
  }

  if (hits.length === 0) {
    source = "shards";
    for (const db of messageShards(ctx)) {
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'",
        )
        .all();
      for (const { name } of tables) {
        const chat =
          ctx.names.usernameOfMd5(name.slice(4)) ?? name;
        if (inChat && chat !== inChat) continue;
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
            [string]
          >(
            `SELECT local_id, local_type, create_time, real_sender_id,
                    message_content, WCDB_CT_message_content
             FROM [${name}] WHERE message_content LIKE ?1
             ORDER BY create_time DESC LIMIT ${limit}`,
          )
          .all(pattern);
        const id2u = id2uOf(db);
        for (const r of rows) {
          if (opts.since && r.create_time < opts.since) continue;
          if (opts.until && r.create_time > opts.until) continue;
          const m = rowToMsg(ctx, chat, chat.endsWith("@chatroom"), r, id2u, new Map());
          hits.push({ ...m, chat, chat_display: ctx.names.display(chat) });
        }
      }
    }
  }
  hits.sort((a, b) => b.timestamp - a.timestamp);
  return { hits: hits.slice(0, limit), source };
}

export function chatStats(ctx: Ctx, chatQuery: string, since?: number, until?: number) {
  const resolved = resolveChat(ctx, chatQuery);
  if (!resolved) throw new Error(`找不到会话: ${chatQuery}`);
  const chat = resolved.username;
  const isGroup = chat.endsWith("@chatroom");
  const nicks = isGroup ? ctx.groupNicknames(chat) : new Map<string, string>();
  const table = msgTableName(chat);
  const perSender = new Map<string, number>();
  const perType = new Map<string, number>();
  let total = 0;
  let first = 0;
  let last = 0;

  for (const db of messageShards(ctx)) {
    if (!tableExists(db, table)) continue;
    const id2u = id2uOf(db);
    const clauses: string[] = [];
    if (since) clauses.push(`create_time >= ${Math.floor(since)}`);
    if (until) clauses.push(`create_time <= ${Math.floor(until)}`);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
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
        []
      >(
        `SELECT local_id, local_type, create_time, real_sender_id,
                message_content, WCDB_CT_message_content
         FROM [${table}] ${where}`,
      )
      .all();
    for (const r of rows) {
      total++;
      if (!first || r.create_time < first) first = r.create_time;
      if (r.create_time > last) last = r.create_time;
      const s = senderOf(
        ctx,
        chat,
        isGroup,
        r.real_sender_id,
        decompressMessage(r.message_content, r.WCDB_CT_message_content ?? 0),
        id2u,
        nicks,
      );
      const key = s.label || "(自己)";
      perSender.set(key, (perSender.get(key) ?? 0) + 1);
      const tid = typeId(r.local_type);
      perType.set(tid, (perType.get(tid) ?? 0) + 1);
    }
  }

  return {
    chat,
    display: resolved.display,
    total,
    first_time: fmtTime(first),
    last_time: fmtTime(last),
    top_senders: [...perSender.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sender, count]) => ({ sender, count })),
    by_type: Object.fromEntries([...perType.entries()].sort((a, b) => b[1] - a[1])),
  };
}
