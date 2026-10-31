import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectFormat } from "./dat.ts";
import { HOME } from "../util.ts";
import { fsPath } from "./paths.ts";
import type { Account } from "./paths.ts";

const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);

export type ImageKey = {
  aesKey: Buffer;
  xorKey: number;
  uin: number;
  source: "kvcomm" | "brute";
};

function md5Hex(s: string): string {
  return createHash("md5").update(s).digest("hex");
}

/** 候选 kvcomm 目录（按优先级） */
export function kvcommDirs(accountRoot: string): string[] {
  const docsRoot = join(HOME, "Library/Containers/com.tencent.xinWeChat/Data/Documents");
  const support = join(
    HOME,
    "Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat",
  );
  const dirs = [
    join(docsRoot, "app_data/net/kvcomm"),
    join(docsRoot, "xwechat/net/kvcomm"),
    join(support, "xwechat/net/kvcomm"),
    join(support, "net/kvcomm"),
    join(accountRoot, "net/kvcomm"),
  ];
  return dirs.map((p) => fsPath(p)).filter((p) => existsSync(p));
}

export function uinsFromKvcomm(dirs: string[]): number[] {
  const out = new Set<number>();
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.startsWith("key_")) continue;
      const uin = Number(n.slice(4).split("_")[0]);
      if (Number.isInteger(uin) && uin > 0) out.add(uin);
    }
  }
  return [...out];
}

/** 账号目录名既是 wxid（可能带 4 位随机后缀） */
export function wxidCandidates(accountId: string): string[] {
  const out = [accountId];
  const m = /^(.+)_([0-9a-f]{4})$/.exec(accountId);
  if (m) out.push(m[1]!);
  return out;
}

/** 采样附件里的 V2 模板，用于反验 key */
export function sampleV2Templates(accountRoot: string, limit = 3): Buffer[] {
  const attach = join(accountRoot, "msg/attach");
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length >= limit || depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= limit) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith("_t.dat")) found.push(p);
    }
  };
  walk(attach, 0);
  if (found.length < limit) {
    const walk2 = (dir: string, depth: number) => {
      if (found.length >= limit || depth > 4) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found.length >= limit) return;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk2(p, depth + 1);
        else if (e.name.endsWith(".dat") && !found.includes(p)) {
          const head = readFileSync(p).subarray(0, 31);
          if (head.length >= 31 && head.subarray(0, 6).equals(V2_MAGIC)) found.push(p);
        }
      }
    };
    walk2(attach, 0);
  }
  return found.map((p) => readFileSync(p)).filter((b) => b.length >= 31 && b.subarray(0, 6).equals(V2_MAGIC));
}

/** 用模板第一块密文反验 AES key */
export function verifyAesKey(aesKey: Buffer, templates: Buffer[]): boolean {
  if (templates.length === 0) return false;
  for (const t of templates) {
    const d = createDecipheriv("aes-128-ecb", aesKey, null);
    d.setAutoPadding(false);
    const plain = Buffer.concat([d.update(t.subarray(15, 31)), d.final()]);
    if (detectFormat(plain) === "bin") return false;
  }
  return true;
}

export function aesKeyFor(uin: number, wxid: string): Buffer {
  return Buffer.from(md5Hex(String(uin) + wxid).slice(0, 16), "latin1");
}

/** 从 10 个 V2 附件的末字节投票推 xor_key（jpeg 以 0xFF 0xD9 结尾） */
export function voteXorKey(accountRoot: string): number | null {
  const attach = join(accountRoot, "msg/attach");
  const samples: Buffer[] = [];
  const walk = (dir: string, depth: number) => {
    if (samples.length >= 10 || depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (samples.length >= 10) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".dat")) {
        try {
          if (statSync(p).size < 32) continue;
          const b = readFileSync(p);
          if (b.subarray(0, 6).equals(V2_MAGIC)) samples.push(b);
        } catch {}
      }
    }
  };
  walk(attach, 0);
  if (samples.length < 3) return null;
  const votes = new Map<number, number>();
  for (const b of samples) {
    const k = b[b.length - 1]! ^ 0xd9;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

/**
 * 优先 kvcomm 派生 + 模板反验；失败则按账号后缀暴力枚举 uin。
 * 返回 null 表示需要用户手动提供 key。
 */
export function resolveImageKey(
  account: Account,
  templates?: Buffer[],
): ImageKey | null {
  const tmpl = templates ?? sampleV2Templates(account.root);
  if (tmpl.length === 0) return null;

  for (const uin of uinsFromKvcomm(kvcommDirs(account.root))) {
    for (const wxid of wxidCandidates(account.id)) {
      const key = aesKeyFor(uin, wxid);
      if (verifyAesKey(key, tmpl)) {
        return { aesKey: key, xorKey: uin & 0xff, uin, source: "kvcomm" };
      }
    }
  }

  const m = /^(.+)_([0-9a-f]{4})$/.exec(account.id);
  const xorKey = voteXorKey(account.root);
  if (!m || xorKey === null) return null;
  const suffix = m[2]!;
  const base = m[1]!;
  for (let upper = 0; upper < 1 << 24; upper++) {
    const uin = ((upper << 8) | xorKey) >>> 0;
    if (md5Hex(String(uin)).slice(0, 4) !== suffix) continue;
    for (const wxid of [account.id, base]) {
      const key = aesKeyFor(uin, wxid);
      if (verifyAesKey(key, tmpl)) return { aesKey: key, xorKey, uin, source: "brute" };
    }
  }
  return null;
}
