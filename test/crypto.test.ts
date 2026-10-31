import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decryptDatabase, deriveKey, matchKeyToDb, readSaltHex } from "../src/core/crypto.ts";
import { decryptWal } from "../src/core/wal.ts";

const DIR = join(tmpdir(), `wx-crypto-test-${process.pid}`);
const HAS_SQLCIPHER = Bun.spawnSync(["which", "sqlcipher"]).exitCode === 0;
const KEY = randomBytes(32);
const KEY_HEX = KEY.toString("hex");

function sqlcipher(dbPath: string, sql: string) {
  const r = Bun.spawnSync(["sqlcipher", dbPath, sql], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

function rows(dbPath: string, sql: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

// WAL 场景：保持连接存活，期间把 库 + wal 复制出去
async function makeWalFixture(base: string) {
  const script = [
    `PRAGMA key="x'${KEY_HEX}'";`,
    "PRAGMA journal_mode=WAL;",
    "PRAGMA wal_autocheckpoint=0;",
    "CREATE TABLE t(a INTEGER);",
    "INSERT INTO t VALUES(1);",
    "INSERT INTO t VALUES(2);",
    "",
  ].join("\n");
  const proc = Bun.spawn(["sqlcipher", base], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  proc.stdin.write(script);
  await proc.stdin.flush();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(`${base}-wal`) && Bun.file(`${base}-wal`).size > 32) break;
    await Bun.sleep(50);
  }
  copyFileSync(base, `${base}-copy`);
  copyFileSync(`${base}-wal`, `${base}-copy-wal`);
  proc.kill(9);
}

afterAll(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {}
});

describe.skipIf(!HAS_SQLCIPHER)("SQLCipher 4 页解密", () => {
  mkdirSync(DIR, { recursive: true });

  test("raw key 可直接解密并还原 SQLite 数据", () => {
    const db = join(DIR, "raw.db");
    sqlcipher(db, `PRAGMA key="x'${KEY_HEX}'"; CREATE TABLE t(a INTEGER, b TEXT); INSERT INTO t VALUES(1,'hello'),(2,'世界');`);
    expect(matchKeyToDb(db, KEY)).toBe(true);
    expect(matchKeyToDb(db, randomBytes(32))).toBe(false);

    const out = join(DIR, "raw-plain.db");
    decryptDatabase(db, out, KEY);
    expect(rows(out, "SELECT a, b FROM t ORDER BY a")).toEqual([
      { a: 1, b: "hello" },
      { a: 2, b: "世界" },
    ]);
  });

  test("passphrase 经 PBKDF2-SHA512(256k) 派生出页密钥", () => {
    const db = join(DIR, "pass.db");
    sqlcipher(db, "PRAGMA key='hunter2'; CREATE TABLE t(x INTEGER); INSERT INTO t VALUES(42);");
    const salt = Buffer.from(readSaltHex(db)!, "hex");
    const key = deriveKey(Buffer.from("hunter2"), salt);
    expect(matchKeyToDb(db, key)).toBe(true);
    expect(matchKeyToDb(db, deriveKey(Buffer.from("wrong"), salt))).toBe(false);

    const out = join(DIR, "pass-plain.db");
    decryptDatabase(db, out, key);
    expect(rows(out, "SELECT x FROM t")).toEqual([{ x: 42 }]);
  });

  test("未 checkpoint 的 WAL 帧解密后可被 SQLite 合并读取", async () => {
    const base = join(DIR, "wal.db");
    writeFileSync(base, "");
    await makeWalFixture(base);
    expect(Bun.file(`${base}-copy-wal`).size).toBeGreaterThan(32);

    const out = join(DIR, "wal-plain.db");
    decryptDatabase(`${base}-copy`, out, KEY);
    const { frames } = decryptWal(`${base}-copy-wal`, `${out}-wal`, KEY);
    expect(frames).toBeGreaterThan(0);

    const conn = new Database(out, { readwrite: true });
    try {
      conn.exec("PRAGMA busy_timeout = 2000");
      conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      conn.exec("PRAGMA journal_mode = DELETE");
    } finally {
      conn.close();
    }
    expect(rows(out, "SELECT a FROM t ORDER BY a")).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
