import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CACHE_DIR } from "../src/util.ts";
import { ensurePlaintext } from "../src/core/cache.ts";
import { readSaltHex } from "../src/core/crypto.ts";
import type { KeyStore } from "../src/core/keys.ts";
import type { DbFile } from "../src/core/paths.ts";

const DIR = join(tmpdir(), `wx-cache-test-${process.pid}`);
const HAS_SQLCIPHER = Bun.spawnSync(["which", "sqlcipher"]).exitCode === 0;
const KEY = randomBytes(32);
const ACCOUNT = "cachetest";

function sqlcipher(dbPath: string, sql: string) {
  const r = Bun.spawnSync(["sqlcipher", dbPath, sql], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

function dbFile(name: string): DbFile {
  const path = join(DIR, name);
  const st = statSync(path);
  return {
    rel: name,
    key: `${ACCOUNT}/${name}`,
    path,
    size: st.size,
    mtimeMs: st.mtimeMs,
    salt: readSaltHex(path),
  };
}

function store(): KeyStore {
  return {
    version: 1,
    dbs: {
      [`${ACCOUNT}/main.db`]: {
        key: KEY.toString("hex"),
        salt: readSaltHex(join(DIR, "main.db"))!,
        source: "raw",
        verifiedAt: new Date().toISOString(),
      },
    },
  };
}

function query(path: string, sql: string) {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

afterAll(() => {
  try {
    rmSync(join(CACHE_DIR, ACCOUNT), { recursive: true, force: true });
    rmSync(DIR, { recursive: true, force: true });
  } catch {}
});

describe.skipIf(!HAS_SQLCIPHER)("解密缓存", () => {
  test("首次解密、命中缓存、源库变化后失效重解", async () => {
    mkdirSync(DIR, { recursive: true });
    const path = join(DIR, "main.db");
    sqlcipher(
      path,
      `PRAGMA key="x'${KEY.toString("hex")}'"; CREATE TABLE t(a INTEGER); INSERT INTO t VALUES(1);`,
    );

    const first = ensurePlaintext(dbFile("main.db"), store());
    expect(first.cached).toBe(false);
    expect(query(first.path, "SELECT a FROM t")).toEqual([{ a: 1 }]);
    // 明文页头自检：解出来的必须是合法 SQLite
    expect(readFileSync(first.path).subarray(0, 15).toString("latin1")).toBe("SQLite format 3");

    const second = ensurePlaintext(dbFile("main.db"), store());
    expect(second.cached).toBe(true);
    expect(second.path).toBe(first.path);

    // 微信侧再写一条（新连接提交），mtime/size 变化应触发重解
    await Bun.sleep(10);
    sqlcipher(path, `PRAGMA key="x'${KEY.toString("hex")}'"; INSERT INTO t VALUES(2);`);
    const third = ensurePlaintext(dbFile("main.db"), store());
    expect(third.cached).toBe(false);
    expect(query(third.path, "SELECT a FROM t ORDER BY a")).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("缺钥匙时明确报错，不产出半成品缓存", () => {
    mkdirSync(DIR, { recursive: true });
    const path = join(DIR, "nokey.db");
    writeFileSync(path, randomBytes(8192));
    const db: DbFile = {
      rel: "nokey.db",
      key: `${ACCOUNT}/nokey.db`,
      path,
      size: 8192,
      mtimeMs: Date.now(),
      salt: readSaltHex(path),
    };
    expect(() => ensurePlaintext(db, { version: 1, dbs: {} })).toThrow(/缺少密钥/);
  });
});
