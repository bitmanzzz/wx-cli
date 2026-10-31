/** 微信 4.x 消息类型与内容解析（不依赖微信内部 tokenizer） */

export function typeCode(t: number): number {
  return t >>> 0 === t ? t : t >>> 0;
}

const TYPE_NAMES: Record<number, string> = {
  1: "文本",
  3: "图片",
  34: "语音",
  42: "名片",
  43: "视频",
  47: "表情",
  48: "位置",
  49: "链接/文件",
  50: "通话",
  10000: "系统",
  10002: "撤回",
};

const TYPE_IDS: Record<number, string> = {
  1: "text",
  3: "image",
  34: "voice",
  42: "card",
  43: "video",
  47: "sticker",
  48: "location",
  49: "appmsg",
  50: "call",
  10000: "system",
  10002: "revoke",
};

export function typeId(t: number): string {
  return TYPE_IDS[typeCode(t)] ?? `type_${typeCode(t)}`;
}

export function fmtType(t: number): string {
  return TYPE_NAMES[typeCode(t)] ?? `type=${typeCode(t)}`;
}

/** WCDB_CT_message_content == 4 表示 zstd 压缩 */
export function decompressMessage(data: Uint8Array | string | null, ct: number): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  const buf = Buffer.from(data);
  if (ct === 4 && buf.length > 0) {
    try {
      return Buffer.from(Bun.zstdDecompressSync(buf)).toString("utf8");
    } catch {}
  }
  return buf.toString("utf8");
}

/** 会话摘要同样可能是 zstd 压缩 */
export function decompressAuto(data: Uint8Array | string | null): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  const buf = Buffer.from(data);
  if (buf.length === 0) return "";
  try {
    return Buffer.from(Bun.zstdDecompressSync(buf)).toString("utf8");
  } catch {}
  return buf.toString("utf8");
}

/** 群消息内容带 `wxid:\n` 前缀，展示时去掉 */
export function stripGroupPrefix(s: string): string {
  const i = s.indexOf(":\n");
  return i >= 0 ? s.slice(i + 2) : s;
}

export function extractXmlText(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(xml);
  if (!m) return null;
  let v = m[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  if (cdata) v = cdata[1]!;
  return v.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

export type AppmsgInfo = {
  type: number | null;
  title: string | null;
  url: string | null;
  summary: string | null;
  referSender: string | null;
  referContent: string | null;
};

export function parseAppmsg(content: string): AppmsgInfo | null {
  const xml = content.includes("<appmsg") ? content : null;
  if (!xml) return null;
  const atype = extractXmlText(xml, "type");
  const title = extractXmlText(xml, "title");
  const url = extractXmlText(xml, "url");
  const desc = extractXmlText(xml, "des") ?? extractXmlText(xml, "digest");
  const refer = /<refermsg>([\s\S]*?)<\/refermsg>/.exec(xml)?.[1] ?? null;
  const referSender = refer ? extractXmlText(refer, "displayname") : null;
  const referContent = refer
    ? (extractXmlText(refer, "content") ?? "").replace(/^[\s\S]*?:\n/, "")
    : null;
  return {
    type: atype ? Number(atype) : null,
    title: title || null,
    url: url || null,
    summary: desc || null,
    referSender: referSender || null,
    referContent: referContent || null,
  };
}

/** 人类可读的消息正文 */
export function fmtContent(localId: number, localType: number, content: string, isGroup: boolean): string {
  const t = typeCode(localType);
  switch (t) {
    case 3:
      return `[图片] local_id=${localId}`;
    case 34:
      return "[语音]";
    case 43:
      return "[视频]";
    case 47:
      return "[表情]";
    case 50:
      return "[通话]";
    case 10000:
      return sysmsg(content);
    case 10002:
      return revoke(content);
  }
  const text = isGroup ? stripGroupPrefix(content) : content;
  if (t === 49) {
    const a = parseAppmsg(text);
    if (a) return appmsgText(a, localId);
  }
  return text;
}

function appmsgText(a: AppmsgInfo, localId: number): string {
  const label = (() => {
    switch (a.type) {
      case 5:
        return "[链接]";
      case 6:
        return "[文件]";
      case 19:
        return "[聊天记录]";
      case 33:
      case 36:
        return "[小程序]";
      case 51:
        return "[视频号]";
      case 57:
        return "[引用]";
      case 2000:
        return "[转账]";
      case 2001:
        return "[红包]";
      default:
        return "[链接/文件]";
    }
  })();
  const head = `${label} ${a.title ?? ""}`.trim();
  if (a.type === 57 && a.referContent !== null) {
    const quoted = a.referContent.replace(/\s+/g, " ").slice(0, 200);
    return `${head}\n  ↳ ${a.referSender ?? "?"}: ${quoted}`;
  }
  if (a.type === 6) return head || `[文件] local_id=${localId}`;
  return head;
}

function sysmsg(xml: string): string {
  const content = extractXmlText(xml, "content");
  if (content && content.length > 0) return `[系统] ${content.slice(0, 50)}`;
  if (!xml.startsWith("<")) return `[系统] ${xml.slice(0, 50)}`;
  return "[系统消息]";
}

function revoke(xml: string): string {
  const content = extractXmlText(xml, "content");
  return content && content.length > 0 ? `[撤回] ${content.slice(0, 30)}` : "[撤回了一条消息]";
}
