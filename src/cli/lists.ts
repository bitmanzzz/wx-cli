import type { Database } from "bun:sqlite";
import type { Ctx } from "../core/ctx.ts";
import { decompressAuto, stripGroupPrefix } from "../core/msg.ts";
import { loadGroupMembers } from "../core/names.ts";
import { fmtTime } from "../core/format.ts";

export type ChatType = "private" | "group" | "official_account" | "folded";

export function chatTypeOf(ctx: Ctx, username: string): ChatType {
  if (username.includes("@chatroom")) return "group";
  if (username === "brandsessionholder" || username === "@placeholder_foldgroup") return "folded";
  if (ctx.names.isVerified(username)) return "official_account";
  if (username.startsWith("gh_") || username.startsWith("biz_")) return "official_account";
  if (username.startsWith("@")) return "official_account";
  return "private";
}

export type SessionRow = {
  username: string;
  display: string;
  chat_type: ChatType;
  unread: number;
  last_timestamp: number;
  last_time: string | null;
  last_msg_type: number;
  last_sender: string;
  summary: string;
};

type RawSession = {
  username: string;
  unread_count: number;
  summary: Uint8Array | string | null;
  last_timestamp: number;
  last_msg_type: number;
  last_msg_sender: string;
  last_sender_display_name: string;
};

export function listSessions(
  ctx: Ctx,
  opts: { limit?: number; filter?: string[]; unreadOnly?: boolean } = {},
): SessionRow[] {
  const db = ctx.db("session/session.db");
  if (!db) throw new Error("无法打开 session.db（检查密钥：wx doctor）");
  const limit = opts.limit ?? 20;
  const rows = db
    .query<RawSession, [number]>(
      `SELECT username, unread_count, summary, last_timestamp, last_msg_type,
              last_msg_sender, last_sender_display_name
       FROM SessionTable WHERE last_timestamp > 0
       ORDER BY last_timestamp DESC LIMIT ?1`,
    )
    .all(opts.unreadOnly || (opts.filter && opts.filter.length > 0) ? 100_000 : limit);

  const out: SessionRow[] = [];
  for (const r of rows) {
    const chat_type = chatTypeOf(ctx, r.username);
    if (opts.filter && opts.filter.length > 0 && !opts.filter.includes(chat_type)) continue;
    if (opts.unreadOnly && (r.unread_count ?? 0) <= 0) continue;
    let summary = decompressAuto(r.summary);
    if (chat_type === "group") summary = stripGroupPrefix(summary);
    const nick =
      chat_type === "group" && r.last_msg_sender
        ? ctx.groupNicknames(r.username).get(r.last_msg_sender) ?? ""
        : "";
    out.push({
      username: r.username,
      display: ctx.names.display(r.username),
      chat_type,
      unread: r.unread_count ?? 0,
      last_timestamp: r.last_timestamp,
      last_time: fmtTime(r.last_timestamp),
      last_msg_type: r.last_msg_type,
      last_sender: nick || r.last_sender_display_name || r.last_msg_sender || "",
      summary,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export type ContactRow = {
  username: string;
  display: string;
  nickname: string;
  remark: string;
  chat_type: ChatType;
};

export function listContacts(ctx: Ctx, query?: string): ContactRow[] {
  let rows = ctx.names.all().map((c) => ({
    username: c.username,
    display: c.remark || c.nickname || c.username,
    nickname: c.nickname,
    remark: c.remark,
    chat_type: chatTypeOf(ctx, c.username),
  }));
  if (query) {
    const q = query.trim();
    rows = rows.filter(
      (r) =>
        r.username === q ||
        r.remark.includes(q) ||
        r.nickname.includes(q) ||
        r.display.includes(q),
    );
  }
  return rows.sort((a, b) => a.display.localeCompare(b.display, "zh"));
}

function groupOwner(contactDb: Database | null, chat: string): string | null {
  if (!contactDb) return null;
  for (const col of ["username", "chat_room_name", "name"]) {
    try {
      const row = contactDb
        .query<{ owner: string | null }, [string]>(
          `SELECT owner FROM chat_room WHERE ${col} = ? LIMIT 1`,
        )
        .get(chat);
      if (row?.owner) return row.owner;
    } catch {}
  }
  return null;
}

export function listMembers(ctx: Ctx, chatQuery: string) {
  const contactDb = ctx.db("contact/contact.db");
  const chat = ctx.names
    .all()
    .find((c) => c.remark === chatQuery || c.nickname === chatQuery || c.username === chatQuery)
    ?.username;
  const username = chat ?? chatQuery;
  const owner = groupOwner(contactDb, username);
  const members = loadGroupMembers(contactDb, username).map((m) => ({
    ...m,
    isOwner: owner !== null && m.username === owner,
  }));
  return { chat: username, display: ctx.names.display(username), members };
}

export function sessionsMeta(ctx: Ctx) {
  const db = ctx.db("session/session.db");
  let sessionLast: number | null = null;
  if (db) {
    try {
      const row = db
        .query<{ t: number | null }, []>("SELECT max(last_timestamp) AS t FROM SessionTable")
        .get();
      sessionLast = row?.t ?? null;
    } catch {}
  }
  return { session_last_timestamp: sessionLast, unknown_shards: ctx.unknownShards() };
}
