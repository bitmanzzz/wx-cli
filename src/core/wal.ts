import { readFileSync, writeFileSync } from "node:fs";
import { decryptPage, type CipherParams, SQLCIPHER4 } from "./crypto.ts";
import { statSync } from "node:fs";

const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAGIC_BE = 0x377f0683;
const FRAME_HEADER = 24;

function walChecksum(
  buf: Buffer,
  from: number,
  to: number,
  s1: number,
  s2: number,
  bigEndian: boolean,
): [number, number] {
  for (let o = from; o + 8 <= to; o += 8) {
    const w0 = bigEndian ? buf.readUInt32BE(o) : buf.readUInt32LE(o);
    const w1 = bigEndian ? buf.readUInt32BE(o + 4) : buf.readUInt32LE(o + 4);
    s1 = (s1 + w0 + s2) >>> 0;
    s2 = (s2 + w1 + s1) >>> 0;
  }
  return [s1, s2];
}

/**
 * 把加密 WAL 解成明文 WAL（帧校验和重算）。
 * 帧结构：24B header(pgno,dbsize,salt1,salt2,cksum1,cksum2) + 加密页
 */
export function decryptWal(
  srcWal: string,
  dstWal: string,
  key: Buffer,
  p: CipherParams = SQLCIPHER4,
): { frames: number; pageSize: number } {
  const data = readFileSync(srcWal);
  if (data.length < 32) {
    writeFileSync(dstWal, Buffer.alloc(0), { mode: 0o600 });
    return { frames: 0, pageSize: p.pageSize };
  }
  const magic = data.readUInt32BE(0);
  if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) {
    throw new Error(`WAL magic 无效: 0x${magic.toString(16)}`);
  }
  const bigEndian = magic === WAL_MAGIC_BE;
  const pageSize = data.readUInt32BE(8);
  if (pageSize !== p.pageSize) {
    throw new Error(`WAL pageSize=${pageSize} 与参数 ${p.pageSize} 不一致`);
  }
  const header = Buffer.from(data.subarray(0, 32));
  let s1 = header.readUInt32BE(24);
  let s2 = header.readUInt32BE(28);

  const frameSize = FRAME_HEADER + pageSize;
  const frames = Math.floor((data.length - 32) / frameSize);
  const out = Buffer.alloc(32 + frames * frameSize);
  header.copy(out, 0);

  for (let i = 0; i < frames; i++) {
    const src = 32 + i * frameSize;
    const dst = 32 + i * frameSize;
    const fh = data.subarray(src, src + FRAME_HEADER);
    const pgno = fh.readUInt32BE(0);
    const page = data.subarray(src + FRAME_HEADER, src + frameSize);
    const plain = decryptPage(key, page, pgno, p);

    fh.copy(out, dst);
    plain.copy(out, dst + FRAME_HEADER);

    // 校验和覆盖帧头前 8 字节 + 页内容（明文）
    [s1, s2] = walChecksum(out, dst, dst + 8, s1, s2, bigEndian);
    [s1, s2] = walChecksum(out, dst + FRAME_HEADER, dst + frameSize, s1, s2, bigEndian);
    out.writeUInt32BE(s1, dst + 16);
    out.writeUInt32BE(s2, dst + 20);
  }
  writeFileSync(dstWal, out, { mode: 0o600 });
  return { frames, pageSize };
}

export function walStat(path: string): { size: number; mtimeMs: number } {
  try {
    const st = statSync(path);
    return st.size > 32 ? { size: st.size, mtimeMs: st.mtimeMs } : { size: 0, mtimeMs: 0 };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}
