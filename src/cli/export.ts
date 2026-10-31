import { writeFileSync } from "node:fs";
import type { Ctx } from "../core/ctx.ts";
import { listMessages, type ListOptions, type Msg } from "./messages.ts";

export type ExportFormat = "markdown" | "json" | "jsonl";

export function exportChat(
  ctx: Ctx,
  chatQuery: string,
  opts: ListOptions & { format?: ExportFormat; out?: string } = {},
) {
  const format = opts.format ?? "markdown";
  const data = listMessages(ctx, chatQuery, { ...opts, limit: opts.limit ?? 2000 });
  const text = render(format, data.display, data.chat, data.messages);
  if (opts.out) {
    writeFileSync(opts.out, text, { mode: 0o600 });
    return {
      chat: data.chat,
      display: data.display,
      format,
      out: opts.out,
      messages: data.messages.length,
      bytes: Buffer.byteLength(text),
    };
  }
  return { chat: data.chat, display: data.display, format, content: text, messages: data.messages.length };
}

function render(format: ExportFormat, display: string, chat: string, messages: Msg[]): string {
  if (format === "json") {
    return JSON.stringify({ chat, display, messages }, null, 2);
  }
  if (format === "jsonl") {
    return messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  }
  const lines: string[] = [`# ${display}`, "", `> 会话: ${chat} · 共 ${messages.length} 条`, ""];
  for (const m of messages) {
    const who = m.sender || "我";
    lines.push(`**${who}** · ${m.time ?? ""}`);
    for (const line of (m.content || "").split("\n")) lines.push(`> ${line}`);
    lines.push("");
  }
  return lines.join("\n");
}
