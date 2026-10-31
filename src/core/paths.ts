import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../util.ts";
import { readSaltHex } from "./crypto.ts";

/**
 * macOS 上 `/Users/...` 是 Data 卷的 firmlink；firmlink 视图偶尔会卡在
 * readdir/读内容（stat 仍正常）。底层真实路径始终可用，优先走它。
 */
export function fsPath(p: string): string {
  if (!p.startsWith("/Users/")) return p;
  const raw = `/System/Volumes/Data${p}`;
  return existsSync(raw) ? raw : p;
}

/** 微信 4.x 数据根目录（WX_FILES_ROOT 可覆盖，测试与多容器场景用） */
export function wechatFilesRoot(): string {
  const root =
    process.env.WX_FILES_ROOT ??
    join(HOME, "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files");
  return fsPath(root);
}

export type Account = {
  /** 目录名，如 wxid_example_1234 */
  id: string;
  /** 该账号的数据根 */
  root: string;
  /** db_storage 目录 */
  dbRoot: string;
};

export type DbFile = {
  /** 相对 db_storage 的路径，如 message/message_0.db */
  rel: string;
  /** 账号内唯一键：<account>/<rel> */
  key: string;
  path: string;
  size: number;
  mtimeMs: number;
  /** 前 16 字节 hex；明文 SQLite 为 null */
  salt: string | null;
};

export function listAccounts(): Account[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(wechatFilesRoot());
  } catch {
    return [];
  }
  const out: Account[] = [];
  for (const id of entries) {
    if (id === "all_users" || id === "Backup") continue;
    const root = join(wechatFilesRoot(), id);
    const dbRoot = join(root, "db_storage");
    try {
      if (!statSync(dbRoot).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({ id, root, dbRoot });
  }
  return out;
}

function walkDbs(dir: string, base: string, out: string[]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      walkDbs(p, base, out);
    } else if (
      e.name.endsWith(".db") &&
      !e.name.endsWith("-wal") &&
      !e.name.endsWith("-shm") &&
      !e.name.includes(".db-")
    ) {
      out.push(p.slice(base.length + 1));
    }
  }
}

export function listDbFiles(account: Account): DbFile[] {
  const rels: string[] = [];
  walkDbs(account.dbRoot, account.dbRoot, rels);
  const out: DbFile[] = [];
  for (const rel of rels) {
    const path = join(account.dbRoot, rel);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    out.push({
      rel,
      key: `${account.id}/${rel}`,
      path,
      size: st.size,
      mtimeMs: st.mtimeMs,
      salt: readSaltHex(path),
    });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 扫描所有账号的库 */
export function scanAll(): { accounts: Account[]; dbs: DbFile[] } {
  const accounts = listAccounts();
  const dbs = accounts.flatMap((a) => listDbFiles(a));
  return { accounts, dbs };
}

export function accountById(id: string): Account | undefined {
  return listAccounts().find((a) => a.id === id);
}
