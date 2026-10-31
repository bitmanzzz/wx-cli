import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export function md5Hex(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

export function msgTableName(username: string): string {
  return `Msg_${md5Hex(username)}`;
}

// ── protobuf 最小解析（chat_room.ext_buffer 里的群名片） ──────────────

function decodeVarint(raw: Uint8Array, offset: number): [number, number] | null {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < raw.length) {
    const byte = raw[pos]!;
    pos++;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value >>> 0, pos];
    shift += 7;
  }
  return null;
}

function protoLenFields(raw: Uint8Array): [number, Uint8Array][] {
  const out: [number, Uint8Array][] = [];
  let i = 0;
  while (i < raw.length) {
    const tag = decodeVarint(raw, i);
    if (!tag) break;
    i = tag[1];
    const fieldNo = tag[0] >>> 3;
    const wire = tag[0] & 7;
    if (wire === 0) {
      const v = decodeVarint(raw, i);
      if (!v) break;
      i = v[1];
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 2) {
      const len = decodeVarint(raw, i);
      if (!len) break;
      i = len[1];
      if (i + len[0] > raw.length) break;
      out.push([fieldNo, raw.subarray(i, i + len[0])]);
      i += len[0];
    } else break;
  }
  return out;
}

function protoStringFields(raw: Uint8Array): [number, string][] {
  const out: [number, string][] = [];
  for (const [no, value] of protoLenFields(raw)) {
    if (value.length === 0 || value.length > 256) continue;
    const text = Buffer.from(value).toString("utf8").trim();
    if (!text || /[\u0000-\u001f]/.test(text)) continue;
    out.push([no, text]);
  }
  return out;
}

function isStrongUsernameHint(v: string): boolean {
  return v.startsWith("wxid_") || v.endsWith("@chatroom") || v.startsWith("gh_") || v.includes("@");
}

function looksLikeUsername(v: string): boolean {
  const t = v.trim();
  if (!t) return false;
  if (isStrongUsernameHint(t)) return true;
  return /^[A-Za-z0-9_-]{3,64}$/.test(t);
}

function pickMemberUsername(strings: [number, string][], targets?: Set<string>): string | null {
  if (targets) {
    const hit = strings.find(([, v]) => targets.has(v));
    return hit ? hit[1] : null;
  }
  for (const fieldNo of [1, 4]) {
    const hit = strings.find(([f, v]) => f === fieldNo && looksLikeUsername(v));
    if (hit) return hit[1];
  }
  const strong = strings.find(([, v]) => isStrongUsernameHint(v));
  return (strong ?? strings.find(([, v]) => looksLikeUsername(v)))?.[1] ?? null;
}

function pickGroupNickname(strings: [number, string][], username: string): string | null {
  let best: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  strings.forEach(([fieldNo, raw], idx) => {
    if (fieldNo !== 2) return;
    const value = raw.trim();
    if (
      !value ||
      value === username ||
      isStrongUsernameHint(value) ||
      value.includes("\n") ||
      value.includes("\r") ||
      value.length > 64
    )
      return;
    let score = looksLikeUsername(value) ? 0 : 20;
    score += Math.max(0, 32 - value.length);
    score = score * 1000 - idx;
    if (score > bestScore) {
      bestScore = score;
      best = value;
    }
  });
  return best;
}

/** 解析 chat_room.ext_buffer → username → 群昵称 */
export function parseGroupNicknameMap(
  extBuffer: Uint8Array,
  targets?: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, chunk] of protoLenFields(extBuffer)) {
    const strings = protoStringFields(chunk);
    if (strings.length === 0) continue;
    const username = pickMemberUsername(strings, targets);
    if (!username || out.has(username)) continue;
    const nick = pickGroupNickname(strings, username);
    if (nick) out.set(username, nick);
  }
  return out;
}

// ── 联系人缓存 ──────────────────────────────────────────────

export type Names = {
  display(username: string): string;
  isVerified(username: string): boolean;
  /** 备注 > 昵称 > wxid */
  contactDisplay(username: string): string;
  nicknameOf(username: string): string;
  remarkOf(username: string): string;
  usernameOfMd5(md5: string): string | null;
  all(): { username: string; nickname: string; remark: string; verified: boolean }[];
};

type Row = { username: string; nick_name: string; remark: string; verify_flag: number };

export function loadNames(contactDb: Database | null): Names {
  const byUser = new Map<string, Row>();
  const md5ToUser = new Map<string, string>();
  if (contactDb) {
    try {
      const rows = contactDb
        .query<Row, []>("SELECT username, nick_name, remark, verify_flag FROM contact")
        .all();
      for (const r of rows) {
        if (!r.username) continue;
        byUser.set(r.username, {
          username: r.username,
          nick_name: r.nick_name ?? "",
          remark: r.remark ?? "",
          verify_flag: r.verify_flag ?? 0,
        });
        md5ToUser.set(md5Hex(r.username), r.username);
      }
    } catch {
      // contact.db 表名/列名不匹配时降级为空表
    }
  }

  const contactDisplay = (u: string) => {
    const r = byUser.get(u);
    if (!r) return u;
    return r.remark || r.nick_name || u;
  };

  return {
    display: contactDisplay,
    contactDisplay,
    nicknameOf: (u) => byUser.get(u)?.nick_name ?? "",
    remarkOf: (u) => byUser.get(u)?.remark ?? "",
    isVerified: (u) => (byUser.get(u)?.verify_flag ?? 0) !== 0,
    usernameOfMd5: (m) => md5ToUser.get(m) ?? null,
    all: () =>
      [...byUser.values()].map((r) => ({
        username: r.username,
        nickname: r.nick_name,
        remark: r.remark,
        verified: r.verify_flag !== 0,
      })),
  };
}

/** 群昵称表：chat_room.ext_buffer */
export function loadGroupNicknames(contactDb: Database | null, chat: string): Map<string, string> {
  if (!contactDb || !chat.endsWith("@chatroom")) return new Map();
  const queries = [
    "SELECT ext_buffer FROM chat_room WHERE username = ? LIMIT 1",
    "SELECT ext_buffer FROM chat_room WHERE chat_room_name = ? LIMIT 1",
    "SELECT ext_buffer FROM chat_room WHERE name = ? LIMIT 1",
  ];
  for (const sql of queries) {
    try {
      const row = contactDb.query<{ ext_buffer: Uint8Array | null }, [string]>(sql).get(chat);
      if (row?.ext_buffer) return parseGroupNicknameMap(row.ext_buffer);
    } catch {}
  }
  return new Map();
}

/** 群成员 username 集合（含已退出成员过滤） */
export function loadGroupMembers(
  contactDb: Database | null,
  chat: string,
): { username: string; contactDisplay: string; groupNickname: string; isOwner: boolean }[] {
  if (!contactDb || !chat.endsWith("@chatroom")) return [];
  let roomId: number | null = null;
  for (const sql of [
    "SELECT id FROM chat_room WHERE username = ?",
    "SELECT id FROM chat_room WHERE chat_room_name = ?",
    "SELECT id FROM chat_room WHERE name = ?",
  ]) {
    try {
      const row = contactDb.query<{ id: number }, [string]>(sql).get(chat);
      if (row?.id) {
        roomId = row.id;
        break;
      }
    } catch {}
  }
  if (!roomId) return [];
  const rows = contactDb
    .query<{ username: string; nick_name: string; remark: string }, [number]>(
      `SELECT c.username AS username, c.nick_name AS nick_name, c.remark AS remark
       FROM chatroom_member cm LEFT JOIN contact c ON c.id = cm.member_id
       WHERE cm.room_id = ?`,
    )
    .all(roomId);
  const nicks = loadGroupNicknames(contactDb, chat);
  return rows
    .filter((r) => r.username)
    .map((r) => ({
      username: r.username,
      contactDisplay: r.remark || r.nick_name || r.username,
      groupNickname: nicks.get(r.username) ?? "",
      isOwner: false,
    }));
}
