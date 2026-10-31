import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Account } from "./paths.ts";

export type AttachKind = "image" | "voice" | "video" | "file";

export type AttachmentId = {
  v: 1;
  chat: string;
  local_id: number;
  create_time: number;
  kind: AttachKind;
  db?: number;
};

const KIND_TO_TYPE: Record<AttachKind, number> = { image: 3, voice: 34, video: 43, file: 49 };

function md5Hex(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

export function encodeAttachmentId(p: AttachmentId): string {
  return Buffer.from(JSON.stringify(p)).toString("base64url");
}

export function decodeAttachmentId(s: string): AttachmentId {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  } catch {
    throw new Error("attachment_id 不是合法 base64url JSON");
  }
  const p = raw as AttachmentId;
  if (!p || p.v !== 1 || !p.chat || typeof p.local_id !== "number" || !p.kind) {
    throw new Error("attachment_id 字段不完整（需要 v/chat/local_id/kind）");
  }
  return p;
}

/** 从 packed_info（protobuf）里取附件 md5 */
export function extractMd5(packed: Buffer): string | null {
  const marker = Buffer.from([0x12, 0x22, 0x0a, 0x20]);
  const at = packed.indexOf(marker);
  if (at >= 0 && at + marker.length + 32 <= packed.length) {
    const cand = packed.subarray(at + marker.length, at + marker.length + 32).toString("latin1");
    if (/^[0-9a-f]{32}$/.test(cand)) return cand;
  }
  // 容错：任意连续 32 字节 hex
  for (let i = 0; i + 32 <= packed.length; i++) {
    const cand = packed.subarray(i, i + 32).toString("latin1");
    if (/^[0-9a-f]{32}$/.test(cand)) return cand;
  }
  return null;
}

/** 查 message_resource.db 拿某条消息的附件 md5 */
export function lookupResourceMd5(
  resourceDb: Database,
  chat: string,
  localId: number,
  localType: number,
  createTime?: number,
): string | null {
  const chatRow = resourceDb
    .query<{ id: number }, [string]>("SELECT rowid AS id FROM ChatName2Id WHERE user_name = ?1")
    .get(chat);
  if (!chatRow) return null;

  const type = KIND_TO_TYPE[pickKind(localType)];
  const base = `SELECT packed_info FROM MessageResourceInfo
     WHERE chat_id = ?1 AND message_local_id = ?2
       AND (message_local_type = ?3 OR message_local_type % 4294967296 = ?3)`;
  const rows = (
    createTime
      ? resourceDb
          .query<{ packed_info: Uint8Array }, [number, number, number, number]>(
            `${base} AND message_create_time = ?4 ORDER BY rowid DESC LIMIT 1`,
          )
          .all(chatRow.id, localId, type, createTime)
      : []
  ) as { packed_info: Uint8Array }[];
  const fallback =
    rows.length > 0
      ? rows
      : resourceDb
          .query<{ packed_info: Uint8Array }, [number, number, number]>(
            `${base} ORDER BY message_create_time DESC LIMIT 1`,
          )
          .all(chatRow.id, localId, type);
  const packed = fallback[0]?.packed_info;
  return packed ? extractMd5(Buffer.from(packed)) : null;
}

export function pickKind(localType: number): AttachKind {
  const t = localType % 4294967296;
  if (t === 3) return "image";
  if (t === 34) return "voice";
  if (t === 43) return "video";
  return "file";
}

const MONTH_MS = 1000 * 60 * 60 * 24 * 30;

function monthDirs(createTime: number): string[] {
  const out: string[] = [];
  const d = new Date(createTime * 1000);
  for (const offset of [0, -1, 1]) {
    const x = new Date(d.getTime() + offset * MONTH_MS);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/** 定位附件 .dat：<msg/attach>/<md5(chat)>/<YYYY-MM>/Img/<md5>.dat|_h|_t */
export function resolveDatPath(
  account: Account,
  chat: string,
  md5: string,
  createTime: number,
): string | null {
  const chatDir = join(account.root, "msg/attach", md5Hex(chat));
  if (!existsSync(chatDir)) return null;
  const months = monthDirs(createTime);
  let dirs = months.map((m) => join(chatDir, m)).filter((p) => existsSync(p));
  if (dirs.length === 0) {
    dirs = readdirSync(chatDir)
      .map((n) => join(chatDir, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  }
  for (const dir of dirs) {
    for (const sub of ["Img", ""]) {
      // 4.2 的主流命名是 <md5>_t_M.dat，同时兼容旧版后缀
      for (const suffix of ["", "_h", "_h_M", "_t", "_t_M", "_M"]) {
        const p = join(dir, sub, `${md5}${suffix}.dat`);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}
