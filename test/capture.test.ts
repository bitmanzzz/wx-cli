import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { matchFromOutput } from "../src/keys/capture.ts";
import { readSaltHex, matchKeyToDb, deriveKey } from "../src/core/crypto.ts";
import type { DbFile } from "../src/core/paths.ts";
import type { KeyStore } from "../src/core/keys.ts";

const DIR = join(tmpdir(), `wx-capture-test-${process.pid}`);
const HAS_SQLCIPHER = Bun.spawnSync(["which", "sqlcipher"]).exitCode === 0;

function sqlcipher(dbPath: string, sql: string) {
  const r = Bun.spawnSync(["sqlcipher", dbPath, sql], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

/** 模拟 lldb `memory read --size 1 --count 32 --format x` 的输出 */
function lldbDump(values: Buffer[], noise = true): string {
  const lines = ["(lldb) process attach -p 1234", "Process 1234 stopped", "Breakpoint 1: no locations"];
  for (const v of values) {
    const hex = [...v].map((b) => `0x${b.toString(16).padStart(2, "0")}`);
    // 16 字节一行，与 lldb 实际渲染一致
    lines.push(`0x16f0e9ad0: ${hex.slice(0, 16).join(" ")}`);
    lines.push(`0x16f0e9ae0: ${hex.slice(16).join(" ")}`);
    if (noise) lines.push("(lldb) continue");
  }
  lines.push("(lldb) quit");
  return lines.join("\n");
}

function dbFile(account: string, name: string): DbFile {
  const path = join(DIR, name);
  const st = statSync(path);
  return {
    rel: name,
    key: `${account}/${name}`,
    path,
    size: st.size,
    mtimeMs: st.mtimeMs,
    salt: readSaltHex(path),
  };
}

afterAll(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {}
});

describe.skipIf(!HAS_SQLCIPHER)("取钥输出解析与匹配", () => {
  mkdirSync(DIR, { recursive: true });

  test("raw key：从 hexdump 中识别并匹配到对应库", () => {
    const k1 = randomBytes(32);
    const k2 = randomBytes(32);
    sqlcipher(join(DIR, "a.db"), `PRAGMA key="x'${k1.toString("hex")}'"; CREATE TABLE t(a); INSERT INTO t VALUES(1);`);
    sqlcipher(join(DIR, "b.db"), `PRAGMA key="x'${k2.toString("hex")}'"; CREATE TABLE t(a);`);

    const dbs = [dbFile("acc", "a.db"), dbFile("acc", "b.db")];
    const store: KeyStore = { version: 1, dbs: {} };
    const report = matchFromOutput(lldbDump([randomBytes(32), k1, k2]), dbs, store);

    expect(report.matched).toBe(2);
    expect(report.missing).toEqual([]);
    expect(report.candidates).toBe(3);
    expect(store.dbs["acc/a.db"]?.key).toBe(k1.toString("hex"));
    expect(matchKeyToDb(dbs[0]!.path, Buffer.from(store.dbs["acc/a.db"]!.key, "hex"))).toBe(true);
  });

  test("passphrase：只在一个探针库上撞中后派生全部库", () => {
    // 64 位 hex 会被 SQLCipher 当 raw key，这里用带前缀的字符串确保走 PBKDF2
    const pass = Buffer.from(`wx-pass-${randomBytes(12).toString("hex")}`); // 恰 32 字节
    const names = ["p0.db", "p1.db", "p2.db"];
    for (const n of names) {
      sqlcipher(join(DIR, n), `PRAGMA key='${pass.toString("utf8")}'; CREATE TABLE t(a);`);
    }
    const dbs = names.map((n) => dbFile("acc", n));
    const store: KeyStore = { version: 1, dbs: {} };
    const report = matchFromOutput(lldbDump([randomBytes(32), pass]), dbs, store);

    expect(report.passphrase).toBe(pass.toString("hex"));
    expect(report.matched).toBe(3);
    expect(Object.keys(store.dbs)).toHaveLength(3);
    const salt = Buffer.from(readSaltHex(dbs[2]!.path)!, "hex");
    expect(store.dbs[`acc/p2.db`]?.key).toBe(deriveKey(pass, salt).toString("hex"));
  });

  test("lldb Python 回调的 WXKEY 行直接可用", () => {
    const key = randomBytes(32);
    sqlcipher(join(DIR, "w.db"), `PRAGMA key="x'${key.toString("hex")}'"; CREATE TABLE t(a);`);
    const out = [
      "(lldb) process launch",
      "Process 47578 launched: '/tmp/cap' (arm64)",
      `WXKEY ${key.toString("hex")}`,
      "Process 47578 exited with status = 0",
    ].join("\n");
    const store: KeyStore = { version: 1, dbs: {} };
    const report = matchFromOutput(out, [dbFile("acc", "w.db")], store);
    expect(report.candidates).toBe(1);
    expect(report.rawMatched).toBe(1);
    expect(store.dbs["acc/w.db"]?.key).toBe(key.toString("hex"));
  });

  test("垃圾候选不会污染 store", () => {
    sqlcipher(join(DIR, "c.db"), `PRAGMA key="x'${randomBytes(32).toString("hex")}'"; CREATE TABLE t(a);`);
    const store: KeyStore = { version: 1, dbs: {} };
    const dbs = [dbFile("acc", "c.db")];
    const report = matchFromOutput(lldbDump([randomBytes(32), randomBytes(32)]), dbs, store);
    expect(report.matched).toBe(0);
    expect(report.missing).toEqual(["acc/c.db"]);
    expect(store.dbs).toEqual({});
  });
});
