#!/bin/bash
# 取钥：attach 到正在运行的微信副本，捕获 120 秒。需要 sudo。
set -uo pipefail
SECONDS_WANT=${1:-180}
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行：sudo bash $0"
  exit 1
fi
if ! pgrep -x WeChat >/dev/null; then
  echo "微信没在运行。先启动并登录：open -n \"\$HOME/.wx-cli/WeChat.app\""
  exit 1
fi

# 上一轮若被 lldb 留在暂停态（STAT 含 T），先用 root 强制 detach 恢复
PID=$(pgrep -x WeChat | head -1 || true)
if [ -n "${PID:-}" ]; then
  STAT=$(ps -o stat= -p "$PID" | tr -d ' ')
  case "$STAT" in
    T*)
      echo "==> 微信处于暂停状态，先恢复（pid $PID）"
      /usr/bin/lldb --batch -o "process attach -p $PID" -o "process detach" -o "quit" >/dev/null 2>&1 || true
      sleep 1
      ;;
  esac
fi

echo "==> 开始捕获（120 秒）：请在微信里点开几个聊天"
exec "$BUN" run "$ROOT/src/main.ts" key capture --seconds "${SECONDS_WANT:-180}"
