import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { Ctx } from "../core/ctx.ts";
import { resolveChat } from "../core/ctx.ts";
import { fmtTime } from "../core/format.ts";
import { decodeAttachmentId, encodeAttachmentId, type AttachKind } from "../core/attach.ts";

const SILK_MAGIC = Buffer.from("#!SILK_V3", "latin1");

export type VoiceRow = {
  attachment_id: string;
  kind: AttachKind;
  local_id: number;
  timestamp: number;
  time: string | null;
  size: number;
  data_index: number;
  /** 语音在 media_0.db 里的 chat_name_id */
  chat_name_id: number;
};

type NameMap = Map<number, string>;

function chatNameMap(db: Database): NameMap {
  const map = new Map<number, string>();
  try {
    for (const r of db
      .query<{ rowid: number; user_name: string }, []>("SELECT rowid, user_name FROM Name2Id")
      .all())
      if (r.user_name) map.set(r.rowid, r.user_name);
  } catch {}
  return map;
}

function usernameMap(ctx: Ctx): NameMap {
  const db = ctx.db("contact/contact.db");
  const map = new Map<number, string>();
  if (!db) return map;
  try {
    for (const r of db
      .query<{ id: number; username: string }, []>("SELECT id, username FROM contact")
      .all())
      if (r.username) map.set(r.id, r.username);
  } catch {}
  return map;
}

/** 列出某会话的语音消息（存放在 message/media_N.db 的 VoiceInfo 表） */
export function listVoice(
  ctx: Ctx,
  chatQuery: string,
  opts: { limit?: number; since?: number; until?: number } = {},
): { chat: string; display: string; voices: VoiceRow[] } {
  const resolved = resolveChat(ctx, chatQuery);
  if (!resolved) throw new Error(`找不到会话: ${chatQuery}`);
  const chat = resolved.username;

  const voices: VoiceRow[] = [];
  const limit = opts.limit ?? 50;
  for (const d of ctx.dbs) {
    if (!/^message\/media_\d+\.db$/.test(d.rel)) continue;
    const db = ctx.db(d.rel);
    if (!db) continue;
    const names = chatNameMap(db);
    // chat_name_id 在 media 库里用的是该库自己的 Name2Id
    const ids = [...names.entries()].filter(([, u]) => u === chat).map(([id]) => id);
    if (ids.length === 0) continue;
    const clauses = [`chat_name_id IN (${ids.join(",")})`];
    if (opts.since) clauses.push(`create_time >= ${Math.floor(opts.since)}`);
    if (opts.until) clauses.push(`create_time <= ${Math.floor(opts.until)}`);
    const rows = db
      .query<
        {
          local_id: number;
          create_time: number;
          chat_name_id: number;
          size: number;
          data_index: number;
        },
        []
      >(
        `SELECT local_id, create_time, chat_name_id, length(voice_data) AS size, data_index
         FROM VoiceInfo WHERE ${clauses.join(" AND ")}
         ORDER BY create_time DESC LIMIT ${limit}`,
      )
      .all();
    for (const r of rows) {
      voices.push({
        attachment_id: encodeAttachmentId({
          v: 1,
          chat,
          local_id: r.local_id,
          create_time: r.create_time,
          kind: "voice",
        }),
        kind: "voice",
        local_id: r.local_id,
        timestamp: r.create_time,
        time: fmtTime(r.create_time),
        size: r.size ?? 0,
        data_index: r.data_index ?? 0,
        chat_name_id: r.chat_name_id,
      });
    }
  }
  voices.sort((a, b) => b.timestamp - a.timestamp);
  return { chat, display: resolved.display, voices: voices.slice(0, limit) };
}

/** 取出某条语音的原始 silk 数据 */
export function voicePayload(
  ctx: Ctx,
  attachmentId: string,
): { data: Buffer; chat: string; localId: number; createTime: number } {
  const p = decodeAttachmentId(attachmentId);
  if (p.kind !== "voice") throw new Error("这不是语音的 attachment_id");
  for (const d of ctx.dbs) {
    if (!/^message\/media_\d+\.db$/.test(d.rel)) continue;
    const db = ctx.db(d.rel);
    if (!db) continue;
    const names = chatNameMap(db);
    const ids = [...names.entries()].filter(([, u]) => u === p.chat).map(([id]) => id);
    if (ids.length === 0) continue;
    const row = db
      .query<{ voice_data: Uint8Array | null }, [number, number]>(
        `SELECT voice_data FROM VoiceInfo
         WHERE local_id = ?1 AND chat_name_id IN (${ids.join(",")})
         ORDER BY create_time DESC LIMIT 1`,
      )
      .get(p.local_id);
    if (row?.voice_data) {
      return {
        data: Buffer.from(row.voice_data),
        chat: p.chat,
        localId: p.local_id,
        createTime: p.create_time,
      };
    }
  }
  throw new Error("找不到该语音数据（可能已清理）");
}

export type VoiceExtractResult = {
  output: string;
  size: number;
  format: "silk" | "wav";
  converted: boolean;
  hint?: string;
  attachment_id: string;
};

function findSilkDecoder(): string | null {
  for (const bin of ["silk_v3_decoder", "silk_decoder", "silk"]) {
    const r = Bun.spawnSync(["which", bin]);
    if (r.exitCode === 0) return bin;
  }
  return null;
}

/**
 * 导出语音。默认写 `.silk`；`wav: true` 时尝试用系统里的 silk 解码器转 wav。
 * 微信语音是 SILK v3 编码，Bun 内置没有解码器，所以转换依赖外部二进制。
 */
export function extractVoice(
  ctx: Ctx,
  attachmentId: string,
  outPath: string,
  opts: { overwrite?: boolean; wav?: boolean } = {},
): VoiceExtractResult {
  if (existsSync(outPath) && !opts.overwrite) throw new Error(`输出已存在: ${outPath}`);
  const { data } = voicePayload(ctx, attachmentId);
  const looksSilk = data.subarray(0, 9).includes(SILK_MAGIC) || data.includes(SILK_MAGIC);

  if (!opts.wav) {
    writeFileSync(outPath, data, { mode: 0o600 });
    return {
      output: outPath,
      size: data.length,
      format: "silk",
      converted: false,
      hint: looksSilk
        ? "SILK v3 音频；转 wav 用 silk-v3-decoder，或加 --wav 让本工具尝试转换"
        : "非标准 SILK 头，直接落盘",
      attachment_id: attachmentId,
    };
  }

  const decoder = findSilkDecoder();
  if (!decoder) {
    writeFileSync(outPath.replace(/\.wav$/i, "") + ".silk", data, { mode: 0o600 });
    throw new Error(
      "缺少 silk 解码器。安装 silk-v3-decoder（https://github.com/kn007/silk-v3-decoder）后重试，或直接导出 .silk",
    );
  }
  const tmpSilk = `${outPath}.silk`;
  writeFileSync(tmpSilk, data, { mode: 0o600 });
  const r = Bun.spawnSync([decoder, tmpSilk, outPath]);
  if (r.exitCode !== 0) {
    throw new Error(`silk 解码失败：${r.stderr.toString().slice(0, 200)}`);
  }
  return {
    output: outPath,
    size: readFileSync(outPath).length,
    format: "wav",
    converted: true,
    attachment_id: attachmentId,
  };
}
