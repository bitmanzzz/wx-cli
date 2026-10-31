import { cacheStats } from "../core/cache.ts";
import { loadKeys, verifyCoverage } from "../core/keys.ts";
import { scanAll } from "../core/paths.ts";
import { envInfo } from "./init.ts";
import { pickAccount } from "../core/account.ts";

export function doctor() {
  const env = envInfo();
  const { accounts, dbs } = scanAll();
  const store = loadKeys();
  const coverage = verifyCoverage(dbs, store);
  const byAccount = accounts.map((a) => {
    const own = dbs.filter((d) => d.key.startsWith(`${a.id}/`));
    const missing = own.filter((d) => d.salt && !store.dbs[d.key]).map((d) => d.rel);
    return { account: a.id, dbs: own.length, missing };
  });

  // 只以「当前活跃账号」判定整体状态：另一个账号未登录、拿不到密钥是正常的
  const activeId = pickAccount().id;
  const activeDbs = dbs.filter((d) => d.key.startsWith(`${activeId}/`));
  const activeMissing = activeDbs.filter((d) => d.salt && !store.dbs[d.key]);
  const activeOk = activeMissing.length === 0;

  return {
    status: activeOk ? "ok" : "incomplete",
    active_account: activeId,
    env,
    accounts: byAccount,
    keys: {
      total: coverage.total,
      covered: coverage.ok,
      missing: coverage.missing,
      hasPassphrase: Boolean(store.passphrase),
      store: "~/.wx-cli/keys.json",
    },
    cache: cacheStats(),
    hints: activeOk
      ? [
          "当前账号密钥齐全，可直接查询",
          ...(coverage.ok < coverage.total
            ? [`其他账号未登录，缺 ${coverage.total - coverage.ok} 个库的密钥（需要时登录该账号再取钥）`]
            : []),
        ]
      : ["活跃账号密钥不全：sudo bash ~/wx/scripts/keys.sh 60（期间点开聊天）"],
  };
}
