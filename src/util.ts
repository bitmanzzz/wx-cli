import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, chownSync, existsSync } from "node:fs";
import { join } from "node:path";

/** sudo 下 HOME 会变成 /var/root，这里回退到真实用户主目录 */
const sudoUser = process.env.SUDO_USER;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
export const HOME = isRoot && sudoUser ? `/Users/${sudoUser}` : homedir();
export const CONFIG_DIR = join(HOME, ".wx-cli");
export const KEYS_PATH = join(CONFIG_DIR, "keys.json");
export const CACHE_DIR = join(CONFIG_DIR, "cache");
export const COPY_APP = join(CONFIG_DIR, "WeChat.app");
/** root 进程写出的文件要交还真实用户 */
export const OWNER =
  isRoot && process.env.SUDO_UID
    ? { uid: Number(process.env.SUDO_UID), gid: Number(process.env.SUDO_GID ?? 0) }
    : null;

export type Args = {
  _: string[];
  flags: Record<string, string | boolean>;
};

/** 极简参数解析：`--k v` / `--k=v` / `--flag` / `-n 50` */
export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const alias: Record<string, string> = {
    n: "limit",
    j: "json",
    h: "help",
    o: "out",
    f: "format",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const name = alias[a.slice(1)] ?? a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { _: positional, flags };
}

export function flagStr(a: Args, name: string): string | undefined {
  const v = a.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagNum(a: Args, name: string, dflt: number): number {
  const v = flagStr(a, name);
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function flagBool(a: Args, name: string): boolean {
  return a.flags[name] === true || a.flags[name] === "true" || a.flags[name] === "1";
}

export function ensureDir(p: string) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  if (OWNER) {
    try {
      chownSync(p, OWNER.uid, OWNER.gid);
    } catch {}
  }
}

export function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonPrivate(p: string, data: unknown) {
  ensureDir(join(p, ".."));
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {}
  if (OWNER) {
    try {
      chownSync(p, OWNER.uid, OWNER.gid);
    } catch {}
  }
}

export function exists(p: string): boolean {
  return existsSync(p);
}

let outFormat: "json" | "yaml" = "json";

export function setFormat(f: "json" | "yaml") {
  outFormat = f;
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "") return '""';
  if (/^[A-Za-z0-9_./@+-]+$/.test(s) && !/^(true|false|null|\d+)$/i.test(s)) return s;
  return JSON.stringify(s);
}

/** 极简 YAML 序列化（对象/数组/标量，够 agent 与人类读） */
export function toYaml(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const nested = item !== null && typeof item === "object";
        const body = nested ? toYaml(item, indent + 2).trimStart() : yamlScalar(item);
        return nested ? `${pad}- ${body}` : `${pad}- ${body}`;
      })
      .join("\n");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        if (v !== null && typeof v === "object" && (!Array.isArray(v) || v.length > 0)) {
          return `${pad}${k}:\n${toYaml(v, indent + 2)}`;
        }
        return `${pad}${k}: ${yamlScalar(v)}`;
      })
      .join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

export function print(value: unknown) {
  if (outFormat === "yaml") console.log(toYaml(value));
  else console.log(JSON.stringify(value, null, 2));
}

export function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}
