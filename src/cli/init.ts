import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, COPY_APP, ensureDir } from "../util.ts";
import { listAccounts } from "../core/paths.ts";
import { wechatPids } from "../keys/capture.ts";

const APP = "/Applications/WeChat.app";

export type EnvInfo = {
  platform: string;
  arch: string;
  wechatVersion: string | null;
  wechatSignature: string | null;
  wechatRunning: number[];
  accounts: string[];
  dataRoot: string | null;
};

function sh(cmd: string[]): string {
  const r = Bun.spawnSync(cmd);
  return (r.stdout.toString() + r.stderr.toString()).trim();
}

export function envInfo(): EnvInfo {
  const version = sh(["defaults", "read", `${APP}/Contents/Info.plist`, "CFBundleShortVersionString"]);
  const sig = sh(["codesign", "-dv", APP]);
  const flags = /flags=0x([0-9a-f]+)\(([^)]*)\)/.exec(sig);
  const accounts = listAccounts();
  return {
    platform: `${process.platform} ${sh(["sw_vers", "-productVersion"])}`,
    arch: process.arch,
    wechatVersion: version || null,
    wechatSignature: flags ? `0x${flags[1]}(${flags[2]})` : null,
    wechatRunning: wechatPids(),
    accounts: accounts.map((a) => a.id),
    dataRoot: accounts[0]?.root ?? null,
  };
}

export type InitReport = {
  env: EnvInfo;
  copy: { path: string; ready: boolean; created: boolean };
  steps: string[];
};

/**
 * 准备 ad-hoc 副本：macOS 26 的 App Management 禁止原地重签，
 * 必须先 ditto 到用户目录再 codesign，原版签名保持不动。
 */
export function prepareCopy(): InitReport["copy"] {
  ensureDir(CONFIG_DIR);
  if (existsSync(COPY_APP)) {
    return { path: COPY_APP, ready: true, created: false };
  }
  if (!existsSync(join(APP, "Contents/MacOS/WeChat"))) {
    return { path: COPY_APP, ready: false, created: false };
  }
  const ditto = Bun.spawnSync(["ditto", APP, COPY_APP]);
  if (ditto.exitCode !== 0) {
    return { path: COPY_APP, ready: false, created: false };
  }
  // --preserve-metadata=entitlements: 保留沙盒与 app-group，否则副本会用错数据目录
  const sign = Bun.spawnSync([
    "codesign",
    "--force",
    "--deep",
    "--sign",
    "-",
    "--preserve-metadata=entitlements",
    COPY_APP,
  ]);
  return { path: COPY_APP, ready: sign.exitCode === 0, created: true };
}

export function initReport(prepare: boolean): InitReport {
  const env = envInfo();
  const copy = prepare
    ? prepareCopy()
    : { path: COPY_APP, ready: existsSync(COPY_APP), created: false };
  const steps: string[] = [];
  if (env.wechatRunning.length === 0) {
    steps.push("启动微信并登录（或运行 ad-hoc 副本：open -n " + COPY_APP + "）");
  }
  if (copy.ready) {
    steps.push(
      "退出原版微信 → open -n " + copy.path + " → 完成登录确认（数据目录与原版相同）",
    );
  }
  steps.push("sudo wx key capture --seconds 300（期间点开几个聊天；必要时退出后重新登录）");
  steps.push("wx doctor 验证密钥覆盖");
  return { env, copy, steps };
}
