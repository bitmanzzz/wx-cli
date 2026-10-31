import { createCipheriv, createDecipheriv } from "node:crypto";

export type DatFormat = "jpg" | "png" | "gif" | "webp" | "bmp" | "tif" | "hevc" | "bin";
export type Decoder = "v2" | "v1" | "legacy_xor";

export type DecodeResult = {
  data: Buffer;
  format: DatFormat;
  decoder: Decoder;
  /** legacy XOR 反推出的字节；V1/V2 为使用的 xor_key */
  xorKey: number;
};

const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);
const V1_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]);
const HEADER_SIZE = 15;
/** V1 固定 AES key：md5("0")[:16] 的 ASCII */
export const V1_AES_KEY = Buffer.from("cfcd208495d565ef", "latin1");

const MAGICS: { magic: number[]; format: DatFormat }[] = [
  { magic: [0x89, 0x50, 0x4e, 0x47], format: "png" },
  { magic: [0x47, 0x49, 0x46, 0x38], format: "gif" },
  { magic: [0x49, 0x49, 0x2a, 0x00], format: "tif" },
  { magic: [0x52, 0x49, 0x46, 0x46], format: "webp" },
  { magic: [0xff, 0xd8, 0xff], format: "jpg" },
  { magic: [0x42, 0x4d], format: "bmp" },
];

export function detectFormat(b: Buffer): DatFormat {
  if (b.length >= 4 && b.subarray(0, 4).toString("latin1") === "wxgf") return "hevc";
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "webp";
  if (b.length >= 4 && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return "tif";
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  return "bin";
}

function aesEcbDecrypt(key: Buffer, data: Buffer): Buffer {
  const d = createDecipheriv("aes-128-ecb", key, null);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

function aesEcbEncrypt(key: Buffer, data: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

function stripPkcs7(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  const pad = buf[buf.length - 1]!;
  if (pad < 1 || pad > 16 || pad > buf.length) return buf;
  for (let i = buf.length - pad; i < buf.length; i++) if (buf[i] !== pad) return buf;
  return buf.subarray(0, buf.length - pad);
}

/** V1/V2 三段解码；aesKey 缺失时抛错 */
export function decodeVx(buf: Buffer, aesKey: Buffer, xorKey: number): DecodeResult {
  if (buf.length < HEADER_SIZE) throw new Error(".dat 头部不完整");
  const aesSize = buf.readUInt32LE(6);
  const xorSize = buf.readUInt32LE(10);
  const alignedAesSize = aesSize + (16 - (aesSize % 16));
  const aesEnd = HEADER_SIZE + alignedAesSize;
  const rawEnd = buf.length - xorSize;
  if (aesEnd > buf.length || xorSize > buf.length || aesEnd > rawEnd) {
    throw new Error(`.dat 长度字段非法: aes=${aesSize} xor=${xorSize} file=${buf.length}`);
  }
  const aesPlain = stripPkcs7(aesEcbDecrypt(aesKey, buf.subarray(HEADER_SIZE, aesEnd)));
  const raw = buf.subarray(aesEnd, rawEnd);
  const xor = Buffer.from(buf.subarray(rawEnd));
  for (let i = 0; i < xor.length; i++) xor[i] = xor[i]! ^ xorKey;
  const data = Buffer.concat([aesPlain, raw, xor]);
  return { data, format: detectFormat(data), decoder: aesKey.equals(V1_AES_KEY) ? "v1" : "v2", xorKey };
}

/** 旧版单字节 XOR：用图片魔数反推 key */
export function decodeLegacyXor(buf: Buffer): DecodeResult | null {
  for (const { magic, format } of MAGICS) {
    if (buf.length < magic.length) continue;
    const key = buf[0]! ^ magic[0]!;
    let ok = true;
    for (let i = 1; i < magic.length; i++) {
      if ((buf[i]! ^ key) !== magic[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const data = Buffer.from(buf.map((b) => b ^ key));
    if (format === "bmp") {
      if (data.length < 14) continue;
      const size = data.readUInt32LE(2);
      const offset = data.readUInt32LE(10);
      if (Math.abs(data.length - size) >= 1024) continue;
      if (offset < 14 || offset > 1078) continue;
    }
    return { data, format, decoder: "legacy_xor", xorKey: key };
  }
  return null;
}

export type DatKeys = { aesKey?: Buffer; xorKey?: number };

/** 统一入口：按 magic 分派解码器 */
export function decodeDat(buf: Buffer, keys: DatKeys = {}): DecodeResult {
  if (buf.length >= 6 && buf.subarray(0, 6).equals(V2_MAGIC)) {
    if (!keys.aesKey) throw new Error("V2 .dat 需要 image AES key");
    return decodeVx(buf, keys.aesKey, keys.xorKey ?? 0x88);
  }
  if (buf.length >= 6 && buf.subarray(0, 6).equals(V1_MAGIC)) {
    return decodeVx(buf, V1_AES_KEY, keys.xorKey ?? 0x88);
  }
  const legacy = decodeLegacyXor(buf);
  if (legacy) return legacy;
  throw new Error("无法识别的 .dat 格式");
}

/** 构造 V1/V2 文件（测试与自检用） */
export function encodeVx(
  plain: Buffer,
  aesKey: Buffer,
  xorKey: number,
  opts: { v1?: boolean; aesSize?: number; rawSize?: number } = {},
): Buffer {
  const magic = opts.v1 ? V1_MAGIC : V2_MAGIC;
  const aesSize = opts.aesSize ?? plain.length;
  const rawSize = opts.rawSize ?? 0;
  const head = plain.subarray(0, aesSize);
  const raw = plain.subarray(aesSize, aesSize + rawSize);
  const tail = Buffer.from(plain.subarray(aesSize + rawSize));
  for (let i = 0; i < tail.length; i++) tail[i] = tail[i]! ^ xorKey;
  const pad = 16 - (head.length % 16);
  const padded = Buffer.concat([head, Buffer.alloc(pad, pad)]);
  const enc = aesEcbEncrypt(aesKey, padded);
  const header = Buffer.alloc(HEADER_SIZE);
  magic.copy(header, 0);
  header.writeUInt32LE(aesSize, 6);
  header.writeUInt32LE(tail.length, 10);
  return Buffer.concat([header, enc, raw, tail]);
}
