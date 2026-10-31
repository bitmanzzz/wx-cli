import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openPlain, KeyMissingError } from "./cache.ts";
import { loadKeys, type KeyStore } from "./keys.ts";
import { loadGroupNicknames, loadNames, type Names } from "./names.ts";
import { listDbFiles } from "./paths.ts";
import { pickAccount } from "./account.ts";
import type { Account, DbFile } from "./paths.ts";

export type Ctx = {
  account: Account;
  store: KeyStore;
  dbs: DbFile[];
  /** 打开解密后的库；缺钥匙/缺文件返回 null */
  db(rel: string): Database | null;
  names: Names;
  groupNicknames(chat: string): Map<string, string>;
  /** 磁盘上存在但当前没有密钥的库 */
  unknownShards(): string[];
  close(): void;
};

export function loadCtx(accountId?: string): Ctx {
  const account = pickAccount(accountId);
  const store = loadKeys();
  const dbs = listDbFiles(account);
  const opened = new Map<string, Database | null>();
  const byRel = new Map(dbs.map((d) => [d.rel, d]));
  let names: Names | null = null;

  const openRel = (rel: string): Database | null => {
    if (opened.has(rel)) return opened.get(rel)!;
    const file = byRel.get(rel);
    let conn: Database | null = null;
    if (file) {
      try {
        conn = openPlain(file, store).db;
      } catch (e) {
        if (!(e instanceof KeyMissingError)) {
          console.error(`${rel} 打开失败: ${(e as Error).message}`);
        }
      }
    }
    opened.set(rel, conn);
    return conn;
  };

  const ctx: Ctx = {
    account,
    store,
    dbs,
    db: openRel,
    get names() {
      if (!names) names = loadNames(openRel("contact/contact.db"));
      return names;
    },
    groupNicknames: (chat) => loadGroupNicknames(openRel("contact/contact.db"), chat),
    unknownShards: () =>
      dbs.filter((d) => d.salt && !store.dbs[d.key]).map((d) => d.rel),
    close: () => {
      for (const c of opened.values()) c?.close();
      opened.clear();
    },
  };
  return ctx;
}

export function dbPath(account: Account, rel: string): string {
  return join(account.dbRoot, rel);
}

/** 按名字解析会话：username 精确 > 备注/昵称精确 > 子串 */
export function resolveChat(
  ctx: Ctx,
  query: string,
): { username: string; display: string } | null {
  const all = ctx.names.all();
  const direct = all.find((c) => c.username === query);
  if (direct) return { username: direct.username, display: ctx.names.display(direct.username) };

  const exact = all.find((c) => c.remark === query || c.nickname === query);
  if (exact) return { username: exact.username, display: ctx.names.display(exact.username) };

  const fuzzy = all.filter(
    (c) => (c.remark && c.remark.includes(query)) || (c.nickname && c.nickname.includes(query)),
  );
  if (fuzzy.length === 1) {
    return { username: fuzzy[0]!.username, display: ctx.names.display(fuzzy[0]!.username) };
  }
  if (fuzzy.length > 1) {
    const names = fuzzy.map((c) => `${c.remark || c.nickname}(${c.username})`).join(", ");
    throw new Error(`会话名不唯一: ${query} → ${names}`);
  }
  return null;
}

/** 找出会话所在的 message 分片与表名 */
export function messageShards(ctx: Ctx): Database[] {
  const out: Database[] = [];
  for (const d of ctx.dbs) {
    if (!/^message\/message_\d+\.db$/.test(d.rel)) continue;
    const conn = ctx.db(d.rel);
    if (conn) out.push(conn);
  }
  return out;
}

export function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name = ?1",
    )
    .get(name);
  return (row?.n ?? 0) > 0;
}
