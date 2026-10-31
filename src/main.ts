#!/usr/bin/env bun
import { die, flagBool, flagNum, flagStr, parseArgs, print, setFormat } from "./util.ts";
import { doctor } from "./cli/doctor.ts";
import { initReport } from "./cli/init.ts";
import { captureKeys } from "./keys/capture.ts";
import { loadKeys, saveKeys, verifyCoverage } from "./core/keys.ts";
import { scanAll } from "./core/paths.ts";
import { openPlain } from "./core/cache.ts";
import { matchKeyToDb } from "./core/crypto.ts";
import { repairKeys, passphrasesFromLog } from "./core/kdf.ts";
import { loadCtx, type Ctx } from "./core/ctx.ts";
import { listContacts, listMembers, listSessions, sessionsMeta } from "./cli/lists.ts";
import { chatStats, listMessages, searchMessages } from "./cli/messages.ts";
import { exportChat, type ExportFormat } from "./cli/export.ts";
import { newMessages } from "./cli/newmessages.ts";
import { extractAttachment, listAttachments } from "./cli/media.ts";
import { bizArticles, favorites, snsFeed, snsNotifications, snsSearch } from "./cli/extras.ts";
import { parseTimeArg } from "./core/format.ts";

const HELP = `wx — 本地微信数据 CLI（macOS / 微信 4.x）

初始化
  wx init                     准备取钥环境（ad-hoc 副本 + 后续步骤）
  wx doctor                   环境 / 密钥覆盖 / 缓存状态
  wx key list                 查看密钥覆盖
  wx key capture              从微信进程捕获密钥（sudo）
  wx key set <db> <hex>       手工写入并校验某库密钥

消息
  wx sessions                 最近会话
  wx unread                   有未读的会话
  wx new-messages             上次检查后的新消息
  wx history <会话>           聊天记录（-n / --since / --until / --type）
  wx search <关键词>          全库搜索（--in <会话>）
  wx stats <会话>             聊天统计
  wx export <会话>            导出（-f markdown|json|jsonl -o 文件）

通讯录
  wx contacts [--query 关键词]
  wx members <群名>

附件
  wx attachments <会话>       图片附件列表
  wx extract <attachment_id> -o 输出路径

朋友圈 / 公众号 / 收藏
  wx sns-feed / sns-search <关键词> / sns-notifications
  wx biz-articles / wx favorites

调试
  wx schema [db]              表结构
  wx tables                   所有库的表名
  wx raw <db> <SQL>           直接跑 SQL

公共选项: --account <id> --limit/-n <n> --since <日期> --until <日期>`;

type MetaOptions = {
  chatLatest?: number | null;
  chatLatestDb?: string | null;
  windowed?: boolean;
};

function meta(ctx: Ctx, opts: MetaOptions = {}) {
  const dbs = ctx.dbs;
  const unknown = ctx.unknownShards();
  const { session_last_timestamp } = sessionsMeta(ctx);
  const chatLatest = opts.chatLatest ?? session_last_timestamp;
  const status =
    unknown.length > 0
      ? "possibly_stale_unknown_shards"
      : opts.windowed
        ? "windowed"
        : session_last_timestamp && chatLatest && session_last_timestamp - chatLatest > 86400
          ? "possibly_stale"
          : "ok";
  return {
    status,
    account: ctx.account.id,
    dbs_total: dbs.length,
    dbs_known: dbs.length - unknown.length,
    unknown_shards: unknown,
    session_last_timestamp,
    chat_latest_timestamp: chatLatest,
    chat_latest_db: opts.chatLatestDb ?? null,
    source: "local_wechat_sqlcipher",
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];
  const sub = args._[1];

  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log("wx 0.1.0");
    return;
  }
  if (!cmd || cmd === "help" || flagBool(args, "help")) {
    console.log(HELP);
    return;
  }

  setFormat(flagBool(args, "yaml") ? "yaml" : "json");
  const limit = flagNum(args, "limit", 0);
  const since = parseTimeArg(flagStr(args, "since"));
  const until = parseTimeArg(flagStr(args, "until"), true);
  const account = flagStr(args, "account");

  if (cmd === "init") {
    print(initReport(!flagBool(args, "no-copy")));
    return;
  }
  if (cmd === "doctor") {
    print(doctor());
    return;
  }
  if (cmd === "key") {
    const store = loadKeys();
    const { dbs } = scanAll();
    if (sub === "list") {
      const coverage = verifyCoverage(dbs, store);
      print({
        covered: coverage.ok,
        total: coverage.total,
        missing: coverage.missing,
        hasPassphrase: Boolean(store.passphrase),
        keys: Object.entries(store.dbs).map(([db, rec]) => ({
          db,
          source: rec.source,
          verifiedAt: rec.verifiedAt,
        })),
      });
      return;
    }
    if (sub === "capture") {
      print(
        await captureKeys({
          seconds: flagNum(args, "seconds", 300),
          pid: flagNum(args, "pid", 0) || undefined,
          launch: flagBool(args, "launch"),
          appPath: flagStr(args, "app"),
          bursts: flagNum(args, "bursts", 1),
          burstSeconds: flagNum(args, "burst-seconds", 0) || undefined,
          gapSeconds: flagNum(args, "gap-seconds", 3),
          fromFile: flagStr(args, "from"),
        }),
      );
      return;
    }
    if (sub === "repair") {
      const result = repairKeys(dbs, store, passphrasesFromLog());
      saveKeys(store);
      print(result);
      return;
    }
    if (sub === "set") {
      const dbKey = args._[2];
      const hex = args._[3];
      if (!dbKey || !hex || hex.length !== 64) die("用法: wx key set <account/rel.db> <64位hex>");
      const db = dbs.find((d) => d.key === dbKey || d.rel === dbKey);
      if (!db) die(`找不到库: ${dbKey}`);
      const key = Buffer.from(hex, "hex");
      if (!matchKeyToDb(db.path, key)) die("密钥校验失败（HMAC 不匹配）");
      store.dbs[db.key] = {
        key: hex,
        salt: db.salt!,
        source: "raw",
        verifiedAt: new Date().toISOString(),
      };
      saveKeys(store);
      print({ ok: true, db: db.key });
      return;
    }
    die(`未知子命令: key ${sub ?? ""}`);
  }

  const ctx = loadCtx(account);
  try {
    switch (cmd) {
      case "sessions":
      case "unread": {
        const filters = flagStr(args, "filter")?.split(",").filter(Boolean);
        const rows = listSessions(ctx, {
          limit: limit || 20,
          filter: filters,
          unreadOnly: cmd === "unread",
        });
        print({ count: rows.length, sessions: rows, meta: meta(ctx) });
        return;
      }
      case "history": {
        const chat = args._[1];
        if (!chat) die("用法: wx history <会话>");
        const data = listMessages(ctx, chat, {
          limit: limit || 50,
          offset: flagNum(args, "offset", 0),
          since,
          until,
          msgType: flagStr(args, "type"),
        });
        print({
          ...data,
          count: data.messages.length,
          meta: meta(ctx, {
            chatLatest: data.chat_latest_timestamp,
            chatLatestDb: data.chat_latest_db,
            windowed: Boolean(since || until || flagNum(args, "offset", 0) > 0 || flagStr(args, "type")),
          }),
        });
        return;
      }
      case "search": {
        const kw = args._[1];
        if (!kw) die("用法: wx search <关键词>");
        const { hits, source } = searchMessages(ctx, kw, {
          limit: limit || 100,
          since,
          until,
          inChat: flagStr(args, "in"),
        });
        print({ keyword: kw, count: hits.length, source, results: hits, meta: meta(ctx) });
        return;
      }
      case "stats": {
        const chat = args._[1];
        if (!chat) die("用法: wx stats <会话>");
        print({ ...chatStats(ctx, chat, since, until), meta: meta(ctx) });
        return;
      }
      case "export": {
        const chat = args._[1];
        if (!chat) die("用法: wx export <会话> -f markdown -o 文件");
        const format = (flagStr(args, "format") ?? "markdown") as ExportFormat;
        const out = flagStr(args, "out");
        print(
          exportChat(ctx, chat, {
            limit: limit || 2000,
            since,
            until,
            format,
            out,
          }),
        );
        return;
      }
      case "new-messages": {
        print(newMessages(ctx, { limit: limit || 100, update: !flagBool(args, "peek") }));
        return;
      }
      case "contacts": {
        const rows = listContacts(ctx, flagStr(args, "query"));
        print({ count: rows.length, contacts: rows, meta: meta(ctx) });
        return;
      }
      case "members": {
        const chat = args._[1];
        if (!chat) die("用法: wx members <群名>");
        print({ ...listMembers(ctx, chat), meta: meta(ctx) });
        return;
      }
      case "attachments": {
        const chat = args._[1];
        if (!chat) die("用法: wx attachments <会话>");
        print({
          ...listAttachments(ctx, chat, {
            limit: limit || 50,
            since,
            until,
            kind: (flagStr(args, "kind") as never) ?? "image",
          }),
          meta: meta(ctx),
        });
        return;
      }
      case "extract": {
        const id = args._[1];
        const out = flagStr(args, "out");
        if (!id || !out) die("用法: wx extract <attachment_id> -o 输出路径");
        print(
          extractAttachment(ctx, id, out, {
            overwrite: flagBool(args, "overwrite"),
            imageKeyHex: flagStr(args, "image-key"),
          }),
        );
        return;
      }
      case "sns-feed": {
        const rows = snsFeed(ctx, {
          limit: limit || 20,
          user: flagStr(args, "user"),
          since,
          until,
        });
        print({ count: rows.length, posts: rows });
        return;
      }
      case "sns-search": {
        const kw = args._[1];
        if (!kw) die("用法: wx sns-search <关键词>");
        const rows = snsSearch(ctx, kw, {
          limit: limit || 100,
          user: flagStr(args, "user"),
          since,
          until,
        });
        print({ keyword: kw, count: rows.length, posts: rows });
        return;
      }
      case "sns-notifications": {
        const rows = snsNotifications(ctx, {
          limit: limit || 50,
          includeRead: flagBool(args, "include-read"),
        });
        print({ count: rows.length, notifications: rows });
        return;
      }
      case "biz-articles": {
        const rows = bizArticles(ctx, {
          limit: limit || 50,
          account: flagStr(args, "account-name"),
          since,
          until,
        });
        print({ count: rows.length, articles: rows });
        return;
      }
      case "favorites": {
        const rows = favorites(ctx, {
          limit: limit || 100,
          type: flagStr(args, "type"),
          query: flagStr(args, "query"),
        });
        print({ count: rows.length, favorites: rows });
        return;
      }
      case "schema": {
        const target = args._[1]
          ? ctx.dbs.find((d) => d.key === args._[1] || d.rel === args._[1])
          : ctx.dbs[0];
        if (!target) die("找不到库");
        const { db, info } = openPlain(target, ctx.store);
        const tables = db
          .query<{ name: string; sql: string }, []>(
            "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all();
        db.close();
        print({ db: target.key, cached: info.cached, walFrames: info.walFrames, tables });
        return;
      }
      case "tables": {
        const out: Record<string, string[]> = {};
        for (const d of ctx.dbs) {
          const db = ctx.db(d.rel);
          if (!db) {
            out[d.rel] = [];
            continue;
          }
          out[d.rel] = db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all()
            .map((r) => r.name);
        }
        print(out);
        return;
      }
      case "raw": {
        const target = ctx.dbs.find((d) => d.key === args._[1] || d.rel === args._[1]);
        const sql = args._.slice(2).join(" ");
        if (!target || !sql) die("用法: wx raw <account/rel.db> <SQL>");
        const db = ctx.db(target.rel);
        if (!db) die(`无法打开 ${target.rel}`);
        print(db.query(sql).all());
        return;
      }
      default:
        die(`未知命令: ${cmd}\n\n${HELP}`);
    }
  } finally {
    ctx.close();
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e), 1));
