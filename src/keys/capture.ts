import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { CONFIG_DIR, COPY_APP, ensureDir } from "../util.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync } from "node:crypto";
import { deriveKey, matchKeyToDb, matchKeyToDbAuto } from "../core/crypto.ts";
import { parseKdfSamples, PRF_DIGEST, passphrasesFromLog, type KdfSample } from "../core/kdf.ts";
import { loadKeys, saveKeys, type KeyStore } from "../core/keys.ts";
import { scanAll, type DbFile } from "../core/paths.ts";

export type CaptureOptions = {
  seconds: number;
  pid?: number;
  /** 由 lldb 直接启动副本（无需 sudo / attach 权限） */
  launch?: boolean;
  appPath?: string;
  /** 只解析指定文件里的 lldb 输出（调试用） */
  fromFile?: string;
  /** 脉冲采集：每次 attach 的秒数（断点每页都会停，长时间挂会冻住 UI） */
  burstSeconds?: number;
  /** 脉冲次数 */
  bursts?: number;
  /** 脉冲间隔（让微信恢复响应、方便点聊天） */
  gapSeconds?: number;
};

export type CaptureReport = {
  pid: number;
  candidates: number;
  rawMatched: number;
  passphrase: string | null;
  matched: number;
  missing: string[];
  seconds: number;
};

export function wechatPids(): number[] {
  const r = Bun.spawnSync(["pgrep", "-x", "WeChat"]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .toString()
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function captureModulePath(): string {
  return join(import.meta.dir, "lldb_capture.py");
}

/**
 * 断点用 Python 回调（`-F`），不用 `-o` 单行命令：
 * lldb 的 `-o` 只保留最后一条，会导致「读了 key 但不 continue」或反之。
 */
function lldbScript(pid: number, seconds: number, appPath?: string): string {
  const head = [
    "settings set target.preload-symbols false",
    `command script import "${captureModulePath()}"`,
  ];
  // 只挂 CCKeyDerivationPBKDF：它每个库只调用一次（rounds=2 的 HMAC key 派生），
  // 而 CCCryptorCreate/CCCrypt 是逐页调用，挂上去会让微信每解一页就停一次，UI 直接冻死。
  const breakpoints = [
    "breakpoint set -n CCKeyDerivationPBKDF -c '$x2 == 32'",
    "breakpoint command add 1 -F lldb_capture.on_pbkdf",
  ];
  const lines = appPath
    ? [
        ...head,
        `target create "${join(appPath, "Contents/MacOS/WeChat")}"`,
        // launch 会阻塞到进程结束，断点必须先设好
        ...breakpoints,
        "process launch",
      ]
    : [...head, `process attach -p ${pid}`, ...breakpoints, "process continue"];
  lines.push(`# 保活 ${seconds}s：期间请在微信里点开几个聊天 / 或退出后重新登录`);
  return lines.join("\n");
}

function parseCandidates(out: string): string[] {
  const set = new Set<string>();
  let buf: string[] = [];
  for (const rawLine of out.split("\n")) {
    // Python 回调直接打印 WXKEY <64hex>
    const wx = /^\s*WXKEY ([0-9a-fA-F]{64})\s*$/.exec(rawLine);
    if (wx) {
      set.add(wx[1]!.toLowerCase());
      continue;
    }
    const line = rawLine;
    const m = /^\s*0x[0-9a-f]+:\s+((?:0x[0-9a-f]{2}\s*)+)$/i.exec(line);
    if (!m) continue;
    for (const b of m[1]!.trim().split(/\s+/)) buf.push(b.slice(2).toLowerCase());
    while (buf.length >= 32) {
      set.add(buf.slice(0, 32).join(""));
      buf = buf.slice(32);
    }
  }
  return [...set];
}

type LogWriter = ReturnType<ReturnType<typeof Bun.file>["writer"]>;

type Session = {
  proc: ReturnType<typeof Bun.spawn>;
  chunks: string[];
  log: LogWriter;
  done: Promise<void>;
};

function forceDetach(pid: number) {
  if (pid <= 0) return;
  try {
    Bun.spawnSync(
      [
        "/usr/bin/lldb",
        "--batch",
        "-o",
        `process attach -p ${pid}`,
        "-o",
        "process detach",
        "-o",
        "quit",
      ],
      { env: { ...process.env, TERM: "dumb" }, stdout: "ignore", stderr: "ignore" },
    );
  } catch {}
  Bun.spawnSync(["kill", "-CONT", String(pid)]);
}

/** 起一个 lldb 会话并 attach（不阻塞） */
function startSession(pid: number, appPath: string | undefined, log: LogWriter): Session {
  const scriptPath = join(tmpdir(), `wx-cap-${process.pid}-${Date.now()}.lldb`);
  // 先写占位脚本，长度由调用方补齐
  const proc = Bun.spawn(["/usr/bin/lldb"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb" },
  });
  const chunks: string[] = [];
  let keys = 0;

  const pump = async (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      chunks.push(text);
      log.write(text);
      for (const line of text.split("\n")) {
        if (line.includes("WXPBKDF ")) console.error(`  ${line.trim().slice(0, 110)}`);
        else if (line.includes("WXKEY ")) {
          keys++;
          if (keys <= 5) console.error(`  key#${keys} ${line.trim().slice(0, 46)}…`);
        } else if (/Breakpoint \d+: (where|no locations)|error:/.test(line)) {
          console.error(`  ${line.trim()}`);
        }
      }
    }
  };

  const done = Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array>),
    pump(proc.stderr as ReadableStream<Uint8Array>),
  ]).then(() => undefined);

  const script = lldbScript(pid, 0, appPath);
  writeFileSync(scriptPath, script + "\n", { mode: 0o600 });
  proc.stdin.write(script + "\n");
  proc.stdin.flush();
  try {
    unlinkSync(scriptPath);
  } catch {}
  return { proc, chunks, log, done };
}

/** 结束一个会话：SIGINT 停下 → detach → quit；失败则强杀并强制恢复目标 */
async function stopSession(s: Session, pid: number) {
  s.proc.kill("SIGINT");
  await Bun.sleep(800);
  try {
    s.proc.stdin.write("process detach\nquit\n");
    s.proc.stdin.flush();
  } catch {}
  const exited = await Promise.race([
    s.proc.exited.then(() => true),
    Bun.sleep(4000).then(() => false),
  ]);
  if (!exited) {
    try {
      s.proc.kill("SIGKILL");
    } catch {}
    forceDetach(pid);
  } else {
    // 正常退出也兜一次 SIGCONT，防止目标留在暂停态
    Bun.spawnSync(["kill", "-CONT", String(pid)]);
  }
  await s.done;
}

/** 目标是否仍处于停止状态（ps STAT 含 T） */
function isStopped(pid: number): boolean {
  if (pid <= 0) return false;
  const r = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  return r.stdout.toString().trim().startsWith("T");
}

/** 用候选 key 直接匹配库（raw key 模式） */
function matchRaw(dbs: DbFile[], candidates: Buffer[]): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  for (const db of dbs) {
    if (!db.salt) continue;
    for (const c of candidates) {
      if (matchKeyToDbAuto(db.path, c)) {
        found.set(db.key, c);
        break;
      }
    }
  }
  return found;
}

/** 用 WXPBKDF 抓到的真实 KDF 参数（pw/salt/rounds/prf）派生并逐库校验 */
function matchKdf(
  dbs: DbFile[],
  samples: KdfSample[],
): { matched: Map<string, Buffer>; used: KdfSample[] } {
  const matched = new Map<string, Buffer>();
  const used: KdfSample[] = [];
  for (const s of samples) {
    const digest = PRF_DIGEST[s.prf];
    if (!digest || !s.pw || !s.salt || s.rounds <= 0) continue;
    let key: Buffer;
    try {
      key = pbkdf2Sync(
        Buffer.from(s.pw, "hex"),
        Buffer.from(s.salt, "hex"),
        s.rounds,
        32,
        digest,
      );
    } catch {
      continue;
    }
    let hit = false;
    for (const db of dbs) {
      if (!db.salt || matched.has(db.key)) continue;
      if (matchKeyToDb(db.path, key)) {
        matched.set(db.key, key);
        hit = true;
      }
    }
    if (hit) used.push(s);
  }
  return { matched, used };
}

/** 候选作为 passphrase，先在一个探针库上验证，再对所有库派生 */
function matchPassphrase(
  dbs: DbFile[],
  candidates: Buffer[],
  alreadyMatched: Set<string>,
): { passphrase: Buffer; keys: Map<string, Buffer> } | null {
  const probe = [...dbs]
    .filter((d) => d.salt && !alreadyMatched.has(d.key))
    .sort((a, b) => a.size - b.size)[0];
  if (!probe) return null;
  const salt = Buffer.from(probe.salt!, "hex");
  for (const c of candidates) {
    const key = deriveKey(c, salt);
    if (!matchKeyToDb(probe.path, key)) continue;
    const keys = new Map<string, Buffer>();
    for (const db of dbs) {
      if (!db.salt) continue;
      const k = deriveKey(c, Buffer.from(db.salt, "hex"));
      if (matchKeyToDb(db.path, k)) keys.set(db.key, k);
    }
    return { passphrase: c, keys };
  }
  return null;
}

export function applyKeys(
  store: KeyStore,
  dbs: DbFile[],
  matched: Map<string, Buffer>,
  source: "raw" | "derived",
) {
  const now = new Date().toISOString();
  for (const db of dbs) {
    const k = matched.get(db.key);
    if (!k) continue;
    store.dbs[db.key] = { key: k.toString("hex"), salt: db.salt!, source, verifiedAt: now };
  }
}

export type MatchReport = {
  candidates: number;
  rawMatched: number;
  kdfMatched: number;
  passphrase: string | null;
  matched: number;
  missing: string[];
};

/** 纯函数部分：lldb 输出 → 候选 → 匹配 → 写入 store（不落盘） */
export function matchFromOutput(
  out: string,
  dbs: DbFile[],
  store: KeyStore,
): MatchReport {
  const candidates = parseCandidates(out).map((h) => Buffer.from(h, "hex"));
  const rawMatched = matchRaw(dbs, candidates);
  applyKeys(store, dbs, rawMatched, "raw");

  const kdf = matchKdf(dbs, parseKdfSamples(out));
  applyKeys(store, dbs, kdf.matched, "derived");

  let passphrase: Buffer | null = null;
  const derived = matchPassphrase(dbs, candidates, new Set([...rawMatched.keys(), ...kdf.matched.keys()]));
  if (derived) {
    passphrase = derived.passphrase;
    store.passphrase = passphrase.toString("hex");
    applyKeys(store, dbs, derived.keys, "derived");
  }

  const matched = new Set([
    ...rawMatched.keys(),
    ...kdf.matched.keys(),
    ...(derived?.keys.keys() ?? []),
  ]);
  const missing = dbs.filter((d) => d.salt && !matched.has(d.key)).map((d) => d.key);
  return {
    candidates: candidates.length,
    rawMatched: rawMatched.size,
    kdfMatched: kdf.matched.size,
    passphrase: passphrase ? passphrase.toString("hex") : null,
    matched: matched.size,
    missing,
  };
}

export async function captureKeys(opts: CaptureOptions): Promise<CaptureReport> {
  if (!opts.fromFile && !opts.launch && typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error(
      "取钥需要 root：请在 GUI 终端执行\n  sudo wx key capture --seconds 300\n" +
        "（sudo 会提示输入密码；期间在微信里点开几个聊天，必要时退出登录再登录）",
    );
  }
  const pids = wechatPids();
  const pid = opts.pid ?? pids[0] ?? 0;
  if (!pid && !opts.fromFile && !opts.launch) {
    throw new Error("未找到微信进程：请先启动微信并登录（或运行 ad-hoc 副本）");
  }
  if (opts.launch && pids.length > 0) {
    throw new Error(
      `微信仍在运行（pid ${pids.join(",")}）。launch 模式需要先退出：osascript -e 'quit app "WeChat"'`,
    );
  }
  if (pids.length > 1) {
    console.error(`检测到多个微信进程 ${pids.join(",")}，使用 pid=${pid}（可用 --pid 指定）`);
  }

  const { dbs } = scanAll();
  if (dbs.length === 0) throw new Error("未找到微信数据库目录");

  let rawOut: string;
  if (opts.fromFile) rawOut = readFileSync(opts.fromFile, "utf8");
  else {
    ensureDir(CONFIG_DIR);
    const logPath = join(CONFIG_DIR, "capture.log");
    const log = Bun.file(logPath).writer();
    const bursts = Math.max(1, opts.bursts ?? 1);
    const burstSeconds = opts.burstSeconds ?? opts.seconds;
    const gapSeconds = opts.gapSeconds ?? 3;
    const parts: string[] = [];
    try {
      for (let i = 0; i < bursts; i++) {
        console.error(
          `脉冲 ${i + 1}/${bursts}：attach ${pid}，${burstSeconds}s` +
            (i === 0 ? "（这期间微信会短暂卡住，结束后请在间隙点开聊天）" : ""),
        );
        const s = startSession(pid, opts.launch ? (opts.appPath ?? COPY_APP) : undefined, log);
        await Bun.sleep(burstSeconds * 1000);
        await stopSession(s, pid);
        parts.push(s.chunks.join(""));
        if (isStopped(pid)) {
          console.error("目标仍在暂停状态，强制 detach");
          forceDetach(pid);
        }
        if (i < bursts - 1) await Bun.sleep(gapSeconds * 1000);
      }
    } finally {
      await log.end();
    }
    console.error(`采集结束，日志: ${logPath}`);
    rawOut = parts.join("");
  }

  const store = loadKeys();
  const report = matchFromOutput(rawOut, dbs, store);
  saveKeys(store);
  console.error(
    `候选 ${report.candidates}，raw 命中 ${report.rawMatched}，KDF 命中 ${report.kdfMatched}，覆盖 ${report.matched}/${dbs.length}`,
  );
  if (report.matched === 0) {
    const attached = /Process \d+ stopped|Process \d+ launched|Process \d+ resuming/.test(rawOut);
    const resolved = (rawOut.match(/Breakpoint \d+: where/g) ?? []).length;
    console.error(
      attached
        ? `已附加成功，但断点未命中（已解析 ${resolved}/3）。请重跑并在期间退出登录→重新登录，或点开多个聊天。`
        : "附加失败：lldb 无法 attach。请确认是副本进程、且用 sudo 运行；把 ~/.wx-cli/capture.log 发我。",
    );
  }
  return { pid, seconds: opts.seconds, ...report };
}
