import { Database } from "bun:sqlite";
import {
  closeSync,
  openSync,
  readSync,
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CACHE_DIR, OWNER, readJson, writeJsonPrivate } from "../util.ts";
import { decryptDatabase } from "./crypto.ts";
import { resolveKey, type KeyStore } from "./keys.ts";
import type { DbFile } from "./paths.ts";
import { decryptWal, walStat } from "./wal.ts";

type Meta = Record<string, string>; // dbKey -> signature

const META_PATH = join(CACHE_DIR, "_meta.json");

export class KeyMissingError extends Error {
  constructor(public dbKey: string) {
    super(`缺少密钥: ${dbKey}（先运行 sudo wx key capture）`);
  }
}

function cachePath(db: DbFile): string {
  return join(CACHE_DIR, db.key);
}

function signature(db: DbFile): string {
  const wal = walStat(`${db.path}-wal`);
  return `${db.size}:${Math.round(db.mtimeMs)}:${wal.size}:${Math.round(wal.mtimeMs)}`;
}

function refreshMeta(fn: (m: Meta) => void) {
  const m = readJson<Meta>(META_PATH) ?? {};
  fn(m);
  writeJsonPrivate(META_PATH, m);
}

export type PlainDb = {
  path: string;
  cached: boolean;
  /** 本次从 WAL 解出的帧数 */
  walFrames: number;
};

/** 确保明文库存在且是最新的；返回可直接 SQLite 打开的路径 */
export function ensurePlaintext(db: DbFile, store: KeyStore): PlainDb {
  const target = cachePath(db);
  const sig = signature(db);
  const meta = readJson<Meta>(META_PATH) ?? {};
  if (existsSync(target) && meta[db.key] === sig) {
    return { path: target, cached: true, walFrames: 0 };
  }

  // 明文 SQLite（salt 为 null）直接复制，无需解密
  const resolved = db.salt ? resolveKey(db, store) : { key: Buffer.alloc(0), source: "raw" };
  if (!resolved) throw new KeyMissingError(db.key);

  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (OWNER) {
    try {
      chownSync(dir, OWNER.uid, OWNER.gid);
    } catch {}
  }

  // 微信在运行时会持续写库：复制/解密期间源文件可能变化，校验明文页头并重试一次
  const tmp = `${target}.tmp-${process.pid}`;
  let decrypted = false;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2 && !decrypted; attempt++) {
    try {
      if (db.salt) decryptDatabase(db.path, tmp, resolved.key);
      else writeFileSync(tmp, readFileSync(db.path), { mode: 0o600 });
      decrypted = plaintextHeaderOk(tmp, db.salt ? 4096 : null);
      if (!decrypted) lastErr = new Error("解密后页头不是 SQLite 格式");
    } catch (e) {
      lastErr = e;
    }
    if (!decrypted) {
      for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
        try {
          unlinkSync(p);
        } catch {}
      }
      if (attempt === 0) console.error(`${db.key} 首轮解密异常，重试: ${(lastErr as Error)?.message ?? ""}`);
    }
  }
  if (!decrypted) {
    throw new Error(
      `${db.key} 解密失败（源库正在被微信改写？）: ${(lastErr as Error)?.message ?? "unknown"}`,
    );
  }

  // 解 WAL：帧页用同一把 key，需重算帧校验和
  let walFrames = 0;
  const walPath = `${db.path}-wal`;
  const wal = walStat(walPath);
  if (wal.size > 0) {
    const tmpWal = `${tmp}-wal`;
    try {
      walFrames = decryptWal(walPath, tmpWal, resolved.key).frames;
      const conn = new Database(tmp, { readwrite: true });
      try {
        conn.exec("PRAGMA busy_timeout = 3000");
        conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        conn.exec("PRAGMA journal_mode = DELETE");
      } finally {
        conn.close();
      }
    } catch (e) {
      console.error(`WAL 合并失败（${db.key}），降级为仅主库: ${(e as Error).message}`);
    } finally {
      for (const p of [`${tmp}-wal`, `${tmp}-shm`]) {
        try {
          unlinkSync(p);
        } catch {}
      }
    }
  } else {
    // 没有 WAL 时也要把库从 WAL 头切成 rollback：Bun 的 SQLite 只读打开
    // WAL 模式的库会报 "unable to open database file"（需要 shm）
    try {
      const conn = new Database(tmp, { readwrite: true });
      try {
        conn.exec("PRAGMA journal_mode = DELETE");
      } finally {
        conn.close();
      }
    } catch (e) {
      console.error(`切换 journal_mode 失败（${db.key}）: ${(e as Error).message}`);
    }
  }

  chmodSync(tmp, 0o600);
  if (OWNER) {
    try {
      chownSync(tmp, OWNER.uid, OWNER.gid);
    } catch {}
  }
  renameSync(tmp, target);
  refreshMeta((m) => {
    m[db.key] = sig;
  });
  return { path: target, cached: false, walFrames };
}

/** 只读打开明文库 */
export function openPlain(db: DbFile, store: KeyStore): { db: Database; info: PlainDb } {
  const info = ensurePlaintext(db, store);
  const conn = new Database(info.path, { readonly: true });
  return { db: conn, info };
}

/** 明文页头自检：magic + 页大小 */
function plaintextHeaderOk(path: string, pageSize: number | null): boolean {
  const head = Buffer.alloc(100);
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, head, 0, 100, 0) < 100) return false;
  } finally {
    closeSync(fd);
  }
  if (head.subarray(0, 15).toString("latin1") !== "SQLite format 3") return false;
  return pageSize === null || head.readUInt16BE(16) === pageSize;
}

export function cacheStats() {
  try {
    const st = statSync(CACHE_DIR);
    return { dir: CACHE_DIR, exists: true, mtimeMs: st.mtimeMs };
  } catch {
    return { dir: CACHE_DIR, exists: false };
  }
}
