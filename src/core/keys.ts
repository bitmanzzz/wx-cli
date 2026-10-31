import { KEYS_PATH, readJson, writeJsonPrivate } from "../util.ts";
import { deriveKey, matchKeyToDb } from "./crypto.ts";
import type { DbFile } from "./paths.ts";

export type KeyRecord = {
  /** 32B raw key hex */
  key: string;
  /** 该 key 对应库文件的 16B salt，用于失效检测 */
  salt: string;
  source: "raw" | "derived";
  verifiedAt: string;
};

export type KeyStore = {
  version: 1;
  /** 微信 4.1+ 内存中只剩 passphrase，用 per-db salt 派生 raw key */
  passphrase?: string;
  dbs: Record<string, KeyRecord>;
};

export function loadKeys(): KeyStore {
  return readJson<KeyStore>(KEYS_PATH) ?? { version: 1, dbs: {} };
}

export function saveKeys(store: KeyStore) {
  writeJsonPrivate(KEYS_PATH, store);
}

export type ResolvedKey = { key: Buffer; source: "raw" | "derived" | "passphrase" };

/**
 * 取某库可用的 raw key：
 * 1. 已有记录且 salt 未变 → 直接用（再用 HMAC 复核，避免 stale）
 * 2. 有 passphrase → 按当前 salt 派生（结果写回）
 */
export function resolveKey(db: DbFile, store: KeyStore): ResolvedKey | null {
  const rec = store.dbs[db.key];
  if (rec && rec.salt === db.salt) {
    const key = Buffer.from(rec.key, "hex");
    if (matchKeyToDb(db.path, key)) return { key, source: "raw" };
  }
  if (!store.passphrase || !db.salt) return null;
  const key = deriveKey(Buffer.from(store.passphrase, "hex"), Buffer.from(db.salt, "hex"));
  if (!matchKeyToDb(db.path, key)) return null;
  store.dbs[db.key] = {
    key: key.toString("hex"),
    salt: db.salt,
    source: "derived",
    verifiedAt: new Date().toISOString(),
  };
  return { key, source: "derived" };
}

/** 校验并刷新整库密钥覆盖，返回统计 */
export function verifyCoverage(dbs: DbFile[], store: KeyStore) {
  let ok = 0;
  const missing: string[] = [];
  for (const db of dbs) {
    if (!db.salt) {
      ok++;
      continue;
    }
    if (resolveKey(db, store)) ok++;
    else missing.push(db.key);
  }
  saveKeys(store);
  return { total: dbs.length, ok, missing };
}
