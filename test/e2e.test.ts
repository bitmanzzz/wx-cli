import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CACHE_DIR } from "../src/util.ts";
import { V1_AES_KEY, encodeVx } from "../src/core/dat.ts";
import { loadCtx } from "../src/core/ctx.ts";
import { listContacts, listMembers, listSessions } from "../src/cli/lists.ts";
import { chatStats, listMessages, searchMessages } from "../src/cli/messages.ts";
import { exportChat } from "../src/cli/export.ts";
import { extractAttachment, listAttachments } from "../src/cli/media.ts";
import { parseGroupNicknameMap } from "../src/core/names.ts";

const ROOT = join(tmpdir(), `wx-e2e-${process.pid}`);
const ACCOUNT = "e2eacct";
const DB = join(ROOT, ACCOUNT, "db_storage");
const GROUP = "123456@chatroom";
const GROUP_NAME = "测试群";
const ALICE = "wxid_alice";
const BOB = "wxid_bob";
const ME = "wxid_me";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const IMG_MD5 = md5("image-one");

function exec(path: string, fn: (db: Database) => void) {
  const db = new Database(path, { readwrite: true, create: true });
  try {
    fn(db);
  } finally {
    db.close();
  }
}

/** 最小 protobuf：field1=username, field2=nickname */
function groupExt(wxid: string, nickname: string): Uint8Array {
  const field = (no: number, text: string) => {
    const bytes = Buffer.from(text, "utf8");
    return Buffer.concat([Buffer.from([(no << 3) | 2, bytes.length]), bytes]);
  };
  const chunk = Buffer.concat([field(1, wxid), field(2, nickname)]);
  return Buffer.concat([Buffer.from([(1 << 3) | 2, chunk.length]), chunk]);
}

beforeAll(() => {
  process.env.WX_FILES_ROOT = ROOT;
  for (const dir of ["session", "contact", "message"]) mkdirSync(join(DB, dir), { recursive: true });

  exec(join(DB, "session/session.db"), (db) => {
    db.run(`CREATE TABLE SessionTable (
      username TEXT, unread_count INTEGER, summary BLOB, last_timestamp INTEGER,
      last_msg_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT)`);
    const insert = db.prepare("INSERT INTO SessionTable VALUES (?,?,?,?,?,?,?)");
    insert.run(GROUP, 2, `:${ALICE}:\n大家好`, 1700000000, 1, ALICE, "小艾");
    insert.run(BOB, 0, "在吗", 1700000100, 1, BOB, "老王");
  });

  exec(join(DB, "contact/contact.db"), (db) => {
    db.run("CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, nick_name TEXT, remark TEXT, verify_flag INTEGER)");
    db.run("CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, ext_buffer BLOB)");
    db.run("CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER)");
    const ins = db.prepare("INSERT INTO contact VALUES (?,?,?,?,?)");
    ins.run(1, ME, "我", "", 0);
    ins.run(2, ALICE, "Alice昵称", "", 0);
    ins.run(3, BOB, "Bob昵称", "老王", 0);
    ins.run(4, GROUP, "测试群", "", 0);
    db.run("INSERT INTO chat_room VALUES (10, ?, ?)", [
      GROUP,
      Buffer.from(groupExt(ALICE, "小艾群名片")),
    ]);
    db.run("INSERT INTO chatroom_member VALUES (10, 1), (10, 2), (10, 3)");
  });

  exec(join(DB, `message/message_0.db`), (db) => {
    const table = `Msg_${md5(GROUP)}`;
    db.run(`CREATE TABLE [${table}] (
      local_id INTEGER, server_id INTEGER, local_type INTEGER, create_time INTEGER,
      real_sender_id INTEGER, message_content BLOB, WCDB_CT_message_content INTEGER)`);
    db.run(`CREATE TABLE Name2Id (rowid INTEGER PRIMARY KEY, user_name TEXT)`);
    db.run("INSERT INTO Name2Id VALUES (1, ?)", [ALICE]);
    db.run("INSERT INTO Name2Id VALUES (2, ?)", [BOB]);
    const ins = db.prepare(`INSERT INTO [${table}] VALUES (?,?,?,?,?,?,?)`);
    ins.run(1, 1, 1, 1700000000, 1, `${ALICE}:\n大家好`, 0);
    ins.run(2, 2, 1, 1700000050, 2, `${BOB}:\n有人吗`, 0);
    ins.run(3, 3, 3, 1700000200, 1, "", 0);
    ins.run(4, 4, 49, 1700000300, 2, `${BOB}:\n<msg><appmsg><title>一篇文章</title><type>5</type><url>https://example.com/a</url></appmsg></msg>`, 0);
  });

  exec(join(DB, "message/message_fts.db"), (db) => {
    db.run("CREATE TABLE name2id (rowid INTEGER PRIMARY KEY, username TEXT)");
    db.run("INSERT INTO name2id VALUES (1, ?)", [GROUP]);
    db.run("CREATE TABLE message_fts_v4_0_content (c0 TEXT, c1 INTEGER, c2 INTEGER, c3 INTEGER, c4 INTEGER, c5 INTEGER, c6 INTEGER)");
    db.run("INSERT INTO message_fts_v4_0_content VALUES ('有人知道这个吗', 9, 1, 1, 1, 1, 1700000400)");
  });

  exec(join(DB, "message/message_resource.db"), (db) => {
    db.run("CREATE TABLE ChatName2Id (rowid INTEGER PRIMARY KEY, user_name TEXT)");
    db.run("CREATE TABLE MessageResourceInfo (chat_id INTEGER, message_local_id INTEGER, message_local_type INTEGER, message_create_time INTEGER, packed_info BLOB)");
    db.run("INSERT INTO ChatName2Id VALUES (1, ?)", [GROUP]);
    const packed = Buffer.concat([Buffer.from([0x12, 0x22, 0x0a, 0x20]), Buffer.from(IMG_MD5, "latin1")]);
    db.run("INSERT INTO MessageResourceInfo VALUES (1, 3, 3, 1700000200, ?)", [packed]);
  });

  const attachDir = join(ROOT, ACCOUNT, "msg/attach", md5(GROUP), "2023-11/Img");
  mkdirSync(attachDir, { recursive: true });
  writeFileSync(join(attachDir, `${IMG_MD5}.dat`), encodeVx(JPEG, V1_AES_KEY, 0x88, { v1: true }));
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
    rmSync(join(CACHE_DIR, ACCOUNT), { recursive: true, force: true });
  } catch {}
  delete process.env.WX_FILES_ROOT;
});

describe("端到端（合成明文库）", () => {
  test("sessions：分类、未读、群摘要去前缀", () => {
    const ctx = loadCtx(ACCOUNT);
    try {
      const rows = listSessions(ctx, { limit: 10 });
      expect(rows).toHaveLength(2);
      const group = rows.find((r) => r.username === GROUP)!;
      expect(group.chat_type).toBe("group");
      expect(group.display).toBe(GROUP_NAME);
      expect(group.summary).toBe("大家好");
      expect(group.unread).toBe(2);
      const priv = rows.find((r) => r.username === BOB)!;
      expect(priv.chat_type).toBe("private");
      expect(priv.display).toBe("老王");
    } finally {
      ctx.close();
    }
  });

  test("history：群昵称优先，引用/链接类型解析正确", () => {
    const ctx = loadCtx(ACCOUNT);
    try {
      const data = listMessages(ctx, GROUP_NAME, { limit: 10 });
      expect(data.messages.map((m) => m.local_id)).toEqual([1, 2, 3, 4]);
      expect(data.messages[0]!.content).toBe("大家好");
      expect(data.messages[0]!.sender).toBe("小艾群名片");
      expect(data.messages[0]!.sender_username).toBe(ALICE);
      expect(data.messages[1]!.sender).toBe("老王");
      const img = data.messages[2]!;
      expect(img.type_id).toBe("image");
      expect(img.content).toBe("[图片] local_id=3");
      const link = data.messages[3]!;
      expect(link.type_id).toBe("appmsg");
      expect(link.content).toBe("[链接] 一篇文章");
      expect(link.url).toBe("https://example.com/a");
    } finally {
      ctx.close();
    }
  });

  test("history 时间范围与条数限制", () => {
    const ctx = loadCtx(ACCOUNT);
    try {
      // limit 取最近 N 条（与 SQL DESC LIMIT 语义一致）
      const data = listMessages(ctx, GROUP_NAME, { limit: 2, since: 1700000040 });
      expect(data.messages.map((m) => m.local_id)).toEqual([3, 4]);
    } finally {
      ctx.close();
    }
  });

  test("search / stats / contacts / members", () => {
    const ctx = loadCtx(ACCOUNT);
    try {
      // 命中 FTS 内容表，并能回填所属会话
      const fts = searchMessages(ctx, "知道");
      expect(fts.source).toBe("message_fts");
      expect(fts.hits[0]!.chat).toBe(GROUP);
      expect(fts.hits[0]!.chat_display).toBe(GROUP_NAME);

      // --in 过滤命中原会话
      expect(searchMessages(ctx, "知道", { inChat: GROUP_NAME }).hits).toHaveLength(1);
      // --in 指向别的会话时命中为空
      expect(searchMessages(ctx, "知道", { inChat: "老王" }).hits).toHaveLength(0);

      // FTS 未命中时回退到分片 LIKE
      const fallback = searchMessages(ctx, "有人吗");
      expect(fallback.source).toBe("shards");
      expect(fallback.hits.some((h) => h.content.includes("有人吗"))).toBe(true);

      const stats = chatStats(ctx, GROUP_NAME);
      expect(stats.total).toBe(4);
      expect(stats.by_type.text).toBe(2);
      expect(stats.top_senders[0]!.count).toBeGreaterThan(0);

      const contacts = listContacts(ctx, "老");
      expect(contacts.some((c) => c.username === BOB)).toBe(true);

      const members = listMembers(ctx, GROUP_NAME);
      expect(members.members.map((m) => m.username).sort()).toEqual([ALICE, BOB, ME].sort());
      expect(members.members.find((m) => m.username === ALICE)?.groupNickname).toBe("小艾群名片");
    } finally {
      ctx.close();
    }
  });

  test("export markdown 含发送者与正文", () => {
    const ctx = loadCtx(ACCOUNT);
    try {
      const out = exportChat(ctx, GROUP_NAME, { format: "markdown", limit: 10 });
      expect(out.content).toContain(`# ${GROUP_NAME}`);
      expect(out.content).toContain("小艾群名片");
      expect(out.content).toContain("> 大家好");
      expect(out.messages).toBe(4);
    } finally {
      ctx.close();
    }
  });

  test("attachments → extract 还原出 JPEG", () => {
    const ctx = loadCtx(ACCOUNT);
    try {
      const { attachments } = listAttachments(ctx, GROUP_NAME, { limit: 10 });
      expect(attachments).toHaveLength(1);
      const a = attachments[0]!;
      expect(a.md5).toBe(IMG_MD5);
      expect(a.dat_path).toContain(`${IMG_MD5}.dat`);

      const outPath = join(ROOT, "out.jpg");
      const report = extractAttachment(ctx, a.attachment_id, outPath);
      expect(report.format).toBe("jpg");
      expect(report.decoder).toBe("v1");
      expect(readFileSync(outPath).equals(JPEG)).toBe(true);
    } finally {
      ctx.close();
    }
  });

  test("群名片 protobuf 解析", () => {
    const map = parseGroupNicknameMap(Buffer.from(groupExt(ALICE, "小艾群名片")));
    expect(map.get(ALICE)).toBe("小艾群名片");
  });
});
