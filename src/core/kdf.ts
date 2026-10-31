import { pbkdf2Sync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../util.ts";
import { matchKeyToDbAuto } from "./crypto.ts";
import type { KeyStore } from "./keys.ts";
import type { DbFile } from "./paths.ts";

/** lldb 抓到的 CCKeyDerivationPBKDF 参数 */
export type KdfSample = { rounds: number; prf: number; salt: string; pw: string };

/** CommonCrypto prf 枚举 → digest */
export const PRF_DIGEST: Record<number, "sha1" | "sha256" | "sha384" | "sha512"> = {
  1: "sha1",
  2: "sha1",
  3: "sha256",
  4: "sha384",
  5: "sha512",
};

export function parseKdfSamples(out: string): KdfSample[] {
  const seen = new Set<string>();
  const list: KdfSample[] = [];
  for (const line of out.split("\n")) {
    const m = /WXPBKDF rounds=(\d+) prf=(\d+) outlen=(\d+) salt=([0-9a-f]+) pw=([0-9a-f]+)/.exec(line);
    if (!m) continue;
    const key = `${m[1]}:${m[2]}:${m[4]}:${m[5]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ rounds: Number(m[1]), prf: Number(m[2]), salt: m[4]!, pw: m[5]! });
  }
  return list;
}

/** 从 capture.log 里挑出 passphrase（rounds 明显大于 2 且长度 32B 的密码） */
export function passphrasesFromLog(): Buffer[] {
  const path = join(CONFIG_DIR, "capture.log");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = new Map<string, Buffer>();
  for (const s of parseKdfSamples(text)) {
    if (s.rounds <= 1000) continue;
    if (s.pw.length !== 64) continue;
    out.set(s.pw, Buffer.from(s.pw, "hex"));
  }
  return [...out.values()];
}

export type RepairResult = {
  fixed: string[];
  stillMissing: string[];
  passphrase: string | null;
};

/**
 * 用已有 passphrase 按「当前 salt」重新派生缺失/失效的库密钥。
 * 微信重建数据库（salt 变化）后无需重新抓包。
 */
export function repairKeys(dbs: DbFile[], store: KeyStore, passphrases: Buffer[]): RepairResult {
  const fixed: string[] = [];
  let used: Buffer | null = null;

  for (const phrase of passphrases) {
    for (const db of dbs) {
      if (!db.salt) continue;
      const rec = store.dbs[db.key];
      if (rec && rec.salt === db.salt && matchKeyToDbAuto(db.path, Buffer.from(rec.key, "hex"))) {
        continue;
      }
      const key = pbkdf2Sync(phrase, Buffer.from(db.salt, "hex"), 256_000, 32, "sha512");
      if (!matchKeyToDbAuto(db.path, key)) continue;
      store.dbs[db.key] = {
        key: key.toString("hex"),
        salt: db.salt,
        source: "derived",
        verifiedAt: new Date().toISOString(),
      };
      fixed.push(db.key);
      used = phrase;
    }
    if (used) break;
  }

  if (used) store.passphrase = used.toString("hex");
  const stillMissing = dbs
    .filter((d) => d.salt && !store.dbs[d.key])
    .map((d) => d.key);
  return {
    fixed,
    stillMissing,
    passphrase: used ? used.toString("hex").slice(0, 8) + "…" : null,
  };
}
