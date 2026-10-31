import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { V1_AES_KEY, decodeDat, decodeLegacyXor, encodeVx } from "../src/core/dat.ts";
import { aesKeyFor, kvcommDirs, resolveImageKey, sampleV2Templates } from "../src/core/imagekey.ts";
import type { Account } from "../src/core/paths.ts";

const DIR = join(tmpdir(), `wx-dat-test-${process.pid}`);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  randomBytes(300),
  Buffer.from([0xff, 0xd9]),
]);

afterAll(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {}
});

describe(".dat 解码", () => {
  test("V1：固定 AES key + XOR 段还原原图", () => {
    const enc = encodeVx(JPEG, V1_AES_KEY, 0x88, { v1: true, aesSize: 100, rawSize: 50 });
    const out = decodeDat(enc);
    expect(out.decoder).toBe("v1");
    expect(out.format).toBe("jpg");
    expect(out.data.equals(JPEG)).toBe(true);
  });

  test("V2：自定义 aes key 与 xor_key", () => {
    const key = randomBytes(16);
    const enc = encodeVx(JPEG, key, 0x5a, { aesSize: 64, rawSize: 100 });
    const out = decodeDat(enc, { aesKey: key, xorKey: 0x5a });
    expect(out.decoder).toBe("v2");
    expect(out.data.equals(JPEG)).toBe(true);
  });

  test("V2 缺 key 时明确失败，不猜", () => {
    const enc = encodeVx(JPEG, randomBytes(16), 0x88);
    expect(() => decodeDat(enc)).toThrow(/image AES key/);
  });

  test("legacy 单字节 XOR：用 jpeg 魔数反推", () => {
    const key = 0x37;
    const enc = Buffer.from(JPEG.map((b) => b ^ key));
    const out = decodeLegacyXor(enc);
    expect(out?.xorKey).toBe(key);
    expect(out?.data.equals(JPEG)).toBe(true);
  });

  test("随机字节不会被误判成图片", () => {
    expect(decodeLegacyXor(randomBytes(4096))).toBeNull();
  });
});

describe("macOS V2 image key", () => {
  const accountRoot = join(DIR, "acc");
  const uin = 1234567890;
  const account: Account = {
    id: "wxid_test_ab12",
    root: accountRoot,
    dbRoot: join(accountRoot, "db_storage"),
  };

  test("从 kvcomm 文件名解析 uin 并派生、反验 key", () => {
    const kv = join(accountRoot, "net/kvcomm");
    mkdirSync(kv, { recursive: true });
    writeFileSync(join(kv, `key_${uin}_1.statistic`), "x");

    const imgDir = join(accountRoot, "msg/attach/deadbeef/2026-10/Img");
    mkdirSync(imgDir, { recursive: true });
    const key = aesKeyFor(uin, account.id);
    writeFileSync(join(imgDir, "aa_t.dat"), encodeVx(JPEG, key, uin & 0xff));

    expect(kvcommDirs(accountRoot)).toContain(kv);
    expect(sampleV2Templates(accountRoot)).toHaveLength(1);

    const resolved = resolveImageKey(account);
    expect(resolved?.source).toBe("kvcomm");
    expect(resolved?.uin).toBe(uin);
    expect(resolved?.xorKey).toBe(uin & 0xff);
    expect(resolved?.aesKey.equals(key)).toBe(true);
  });
});
