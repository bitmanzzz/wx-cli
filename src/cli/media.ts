import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, readJson, writeJsonPrivate } from "../util.ts";
import type { Ctx } from "../core/ctx.ts";
import { messageShards, resolveChat, tableExists } from "../core/ctx.ts";
import { msgTableName } from "../core/names.ts";
import { decodeDat, detectFormat, type DatFormat } from "../core/dat.ts";
import { resolveImageKey, type ImageKey } from "../core/imagekey.ts";
import {
  decodeAttachmentId,
  encodeAttachmentId,
  lookupResourceMd5,
  resolveDatPath,
  type AttachKind,
} from "../core/attach.ts";
import { fmtTime } from "../core/format.ts";

const IMAGEKEY_PATH = join(CONFIG_DIR, "imagekey.json");

export function imageKey(ctx: Ctx, override?: string): ImageKey | null {
  const cached = readJson<{ aesKey: string; xorKey: number; uin: number; source: string }>(
    IMAGEKEY_PATH,
  );
  if (cached && !override) {
    return {
      aesKey: Buffer.from(cached.aesKey, "hex"),
      xorKey: cached.xorKey,
      uin: cached.uin,
      source: cached.source as ImageKey["source"],
    };
  }
  if (override) {
    const [aesHex, xorHex] = override.split(":");
    if (!aesHex || aesHex.length !== 32) throw new Error("--image-key 需要 32 位 hex（16 字节）");
    const k: ImageKey = {
      aesKey: Buffer.from(aesHex, "hex"),
      xorKey: xorHex ? parseInt(xorHex, 16) : 0x88,
      uin: 0,
      source: "kvcomm",
    };
    writeJsonPrivate(IMAGEKEY_PATH, {
      aesKey: k.aesKey.toString("hex"),
      xorKey: k.xorKey,
      uin: k.uin,
      source: k.source,
    });
    return k;
  }
  const resolved = resolveImageKey(ctx.account);
  if (resolved) {
    writeJsonPrivate(IMAGEKEY_PATH, {
      aesKey: resolved.aesKey.toString("hex"),
      xorKey: resolved.xorKey,
      uin: resolved.uin,
      source: resolved.source,
    });
  }
  return resolved;
}

export type AttachmentRow = {
  attachment_id: string;
  kind: AttachKind;
  type: string;
  local_id: number;
  timestamp: number;
  time: string | null;
  md5: string | null;
  dat_path: string | null;
  sender?: string;
  sender_username?: string;
  sender_contact_display?: string;
  sender_group_nickname?: string;
};

export function listAttachments(
  ctx: Ctx,
  chatQuery: string,
  opts: { kind?: AttachKind; limit?: number; since?: number; until?: number } = {},
): { chat: string; display: string; attachments: AttachmentRow[] } {
  const resolved = resolveChat(ctx, chatQuery);
  if (!resolved) throw new Error(`找不到会话: ${chatQuery}`);
  const chat = resolved.username;
  const isGroup = chat.endsWith("@chatroom");
  const table = msgTableName(chat);
  const kind = opts.kind ?? "image";
  const typeCode = kind === "image" ? 3 : kind === "voice" ? 34 : kind === "video" ? 43 : 49;
  const nicks = isGroup ? ctx.groupNicknames(chat) : new Map();
  const resource = ctx.db("message/message_resource.db");
  const limit = opts.limit ?? 50;

  const out: AttachmentRow[] = [];
  for (const db of messageShards(ctx)) {
    if (!tableExists(db, table)) continue;
    const clauses = [`(local_type & 4294967295) = ${typeCode}`];
    if (opts.since) clauses.push(`create_time >= ${Math.floor(opts.since)}`);
    if (opts.until) clauses.push(`create_time <= ${Math.floor(opts.until)}`);
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
         FROM [${table}] WHERE ${clauses.join(" AND ")}
         ORDER BY create_time DESC LIMIT ${limit}`,
      )
      .all();
    let id2u: Map<number, string> = new Map();
    if (tableExists(db, "Name2Id")) {
      for (const r of db
        .query<{ rowid: number; user_name: string }, []>("SELECT rowid, user_name FROM Name2Id")
        .all())
        if (r.user_name) id2u.set(r.rowid, r.user_name);
    }
    for (const r of rows) {
      const md5 = resource
        ? lookupResourceMd5(resource, chat, r.local_id, r.local_type, r.create_time)
        : null;
      const datPath = md5 ? resolveDatPath(ctx.account, chat, md5, r.create_time) : null;
      const senderUsername = id2u.get(r.real_sender_id) ?? "";
      const row: AttachmentRow = {
        attachment_id: encodeAttachmentId({
          v: 1,
          chat,
          local_id: r.local_id,
          create_time: r.create_time,
          kind,
          db: shardNo(db),
        }),
        kind,
        type: "image",
        local_id: r.local_id,
        timestamp: r.create_time,
        time: fmtTime(r.create_time),
        md5,
        dat_path: datPath,
      };
      if (senderUsername && senderUsername !== chat) {
        row.sender = isGroup
          ? nicks.get(senderUsername) || ctx.names.contactDisplay(senderUsername)
          : ctx.names.contactDisplay(senderUsername);
        row.sender_username = senderUsername;
        row.sender_contact_display = ctx.names.contactDisplay(senderUsername);
        row.sender_group_nickname = nicks.get(senderUsername) ?? "";
      }
      out.push(row);
    }
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return { chat, display: resolved.display, attachments: out.slice(0, limit) };
}

function shardNo(db: { filename?: string }): number | undefined {
  const m = /message_(\d+)\.db$/.exec(db.filename ?? "");
  return m ? Number(m[1]) : undefined;
}

export function extractAttachment(
  ctx: Ctx,
  attachmentId: string,
  outPath: string,
  opts: { overwrite?: boolean; imageKeyHex?: string } = {},
) {
  const payload = decodeAttachmentId(attachmentId);
  const dat = resolveDat(payload.chat, payload.local_id, payload.create_time, payload.kind, ctx);
  if (!dat) throw new Error("找不到对应的 .dat 文件（消息可能已被清理/未下载）");
  if (existsSync(outPath) && !opts.overwrite) throw new Error(`输出已存在: ${outPath}`);
  const buf = readFileSync(dat.path);
  const key = imageKey(ctx, opts.imageKeyHex);
  const result =
    payload.kind === "image"
      ? decodeDat(buf, { aesKey: key?.aesKey, xorKey: key?.xorKey })
      : decodeDat(buf);
  writeFileSync(outPath, result.data, { mode: 0o600 });
  return {
    attachment_id: attachmentId,
    md5: dat.md5,
    dat_path: dat.path,
    dat_size: buf.length,
    output: outPath,
    output_size: result.data.length,
    format: result.format,
    decoder: result.decoder,
  };
}

function resolveDat(
  chat: string,
  localId: number,
  createTime: number,
  kind: AttachKind,
  ctx: Ctx,
): { path: string; md5: string } | null {
  const resource = ctx.db("message/message_resource.db");
  if (!resource) return null;
  const typeCode = kind === "image" ? 3 : kind === "voice" ? 34 : kind === "video" ? 43 : 49;
  const md5 = lookupResourceMd5(resource, chat, localId, typeCode, createTime);
  if (!md5) return null;
  const path = resolveDatPath(ctx.account, chat, md5, createTime);
  return path ? { path, md5 } : null;
}

export function sniffFormat(path: string): DatFormat {
  return detectFormat(readFileSync(path).subarray(0, 32));
}
