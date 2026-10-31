import { closeSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { createDecipheriv, createHmac, pbkdf2Sync } from "node:crypto";

/**
 * WeChat 4.x 使用 SQLCipher 4：
 *   page_size = 4096, reserve = 80 (IV 16 + HMAC-SHA512 64)
 *   HMAC key = PBKDF2(raw_key, salt ^ 0x3a, 2, 32, sha512)
 *   页密钥为 raw key（32B 直接用），不做 PBKDF2 派生
 */
export type CipherParams = {
  pageSize: number;
  reserve: number;
  hmacLen: number;
  hmacDigest: "sha512" | "sha1";
  /** passphrase → raw key 的 PBKDF2 迭代次数 */
  kdfIterations: number;
  kdfDigest: "sha512" | "sha1";
};

export const SQLCIPHER4: CipherParams = {
  pageSize: 4096,
  reserve: 80,
  hmacLen: 64,
  hmacDigest: "sha512",
  kdfIterations: 256_000,
  kdfDigest: "sha512",
};

export const SQLCIPHER3: CipherParams = {
  pageSize: 1024,
  reserve: 48,
  hmacLen: 20,
  hmacDigest: "sha1",
  kdfIterations: 64_000,
  kdfDigest: "sha1",
};

export const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
const HMAC_SALT_XOR = 0x3a;

export function xorMacSalt(salt: Buffer): Buffer {
  const out = Buffer.alloc(salt.length);
  for (let i = 0; i < salt.length; i++) out[i] = salt[i]! ^ HMAC_SALT_XOR;
  return out;
}

function hmacKey(key: Buffer, salt: Buffer, p: CipherParams): Buffer {
  return pbkdf2Sync(key, xorMacSalt(salt), 2, 32, p.hmacDigest);
}

/** 校验第一页 HMAC：确认 key 属于该库 */
export function verifyPage1(key: Buffer, page1: Buffer, p: CipherParams = SQLCIPHER4): boolean {
  if (page1.length < p.pageSize) return false;
  const salt = page1.subarray(0, 16);
  const ivEnd = p.pageSize - p.reserve + 16;
  const pgno = Buffer.alloc(4);
  pgno.writeUInt32LE(1, 0);
  const msg = Buffer.concat([page1.subarray(16, ivEnd), pgno]);
  const calc = createHmac(p.hmacDigest, hmacKey(key, salt, p)).update(msg).digest();
  const stored = page1.subarray(p.pageSize - p.hmacLen, p.pageSize);
  return calc.length === stored.length && Buffer.compare(calc, stored) === 0;
}

/** 解密单页；reserve 区按 SQLite 语义补零 */
export function decryptPage(
  key: Buffer,
  page: Buffer,
  pgno: number,
  p: CipherParams = SQLCIPHER4,
): Buffer {
  const dataEnd = p.pageSize - p.reserve;
  const start = pgno === 1 ? 16 : 0;
  const iv = page.subarray(dataEnd, dataEnd + 16);
  const d = createDecipheriv("aes-256-cbc", key, iv);
  d.setAutoPadding(false);
  const plain = Buffer.concat([d.update(page.subarray(start, dataEnd)), d.final()]);
  const out = Buffer.alloc(p.pageSize);
  if (pgno === 1) {
    SQLITE_MAGIC.copy(out, 0);
    plain.copy(out, 16);
    // 保留原样：SQLCipher 在 offset 20 写入 reserve 大小(80)，清零会让 SQLite
    // 把页尾 80 字节当成可用空间，integrity_check 报 fragmentation / malformed
  } else {
    plain.copy(out, 0);
  }
  return out;
}

/** 读首 16 字节 salt；明文 SQLite 返回 null */
export function readSaltHex(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    if (readSync(fd, buf, 0, 16, 0) < 16) return null;
    if (buf.subarray(0, 15).toString("latin1") === "SQLite format 3") return null;
    return buf.toString("hex");
  } finally {
    closeSync(fd);
  }
}

export function readPage1(path: string, pageSize = 4096): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(pageSize);
    const n = readSync(fd, buf, 0, pageSize, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** passphrase → 该库专属 32B raw key */
export function deriveKey(
  passphrase: Buffer,
  salt: Buffer,
  p: CipherParams = SQLCIPHER4,
): Buffer {
  return pbkdf2Sync(passphrase, salt, p.kdfIterations, 32, p.kdfDigest);
}

/** 解密整库，写出明文 SQLite 文件 */
export function decryptDatabase(
  src: string,
  dst: string,
  key: Buffer,
  p: CipherParams = SQLCIPHER4,
): { pages: number; bytes: number } {
  const data = readFileSync(src);
  const pages = Math.floor(data.length / p.pageSize);
  if (pages === 0) throw new Error(`文件小于一页: ${src}`);
  const out = Buffer.alloc(pages * p.pageSize);
  for (let i = 0; i < pages; i++) {
    const off = i * p.pageSize;
    decryptPage(key, data.subarray(off, off + p.pageSize), i + 1, p).copy(out, off);
  }
  writeFileSync(dst, out, { mode: 0o600 });
  return { pages, bytes: out.length };
}

export function matchKeyToDb(path: string, key: Buffer, p: CipherParams = SQLCIPHER4): boolean {
  return verifyPage1(key, readPage1(path, p.pageSize), p);
}

/** 自动试常见参数（4.x 主体是 4096/80，FTS 等少数库可能是 1024/48） */
export function matchKeyToDbAuto(path: string, key: Buffer): CipherParams | null {
  for (const p of [SQLCIPHER4, SQLCIPHER3]) {
    try {
      if (verifyPage1(key, readPage1(path, p.pageSize), p)) return p;
    } catch {}
  }
  return null;
}
