import { readdirSync, statSync } from "node:fs";
import { listAccounts, type Account } from "./paths.ts";

/** 选择账号：显式 --account，否则用最近活跃的账号 */
export function pickAccount(id?: string): Account {
  const accounts = listAccounts();
  if (accounts.length === 0) throw new Error("未找到微信数据目录");
  if (id) {
    const hit = accounts.find((a) => a.id === id);
    if (!hit) throw new Error(`账号不存在: ${id}（可选: ${accounts.map((a) => a.id).join(", ")}）`);
    return hit;
  }
  const scored = accounts
    .map((a) => ({ a, m: latestMtime(a) }))
    .sort((x, y) => y.m - x.m);
  return scored[0]!.a;
}

function latestMtime(a: Account): number {
  let max = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, depth + 1);
      else {
        try {
          const m = statSync(p).mtimeMs;
          if (m > max) max = m;
        } catch {}
      }
    }
  };
  walk(a.dbRoot, 0);
  return max;
}
