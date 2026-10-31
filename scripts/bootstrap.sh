#!/bin/bash
# 一键取钥：退出原版微信 → 启动 ad-hoc 副本 → LLDB 捕获 → 校验
# 必须在「本机 GUI 终端」里运行（Terminal.app / iTerm），不要在 SSH 里跑。
set -uo pipefail

BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COPY="$HOME/.wx-cli/WeChat.app"
ORIG="/Applications/WeChat.app"

if [ ! -d "$COPY" ]; then
  echo "==> 准备 ad-hoc 副本"
  "$BUN" run "$ROOT/src/main.ts" init >/dev/null || { echo "副本创建失败"; exit 1; }
fi

echo "==> 第 1 步：退出原版微信（先保存草稿）"
read -r -p "    回车继续…" _
osascript -e 'quit app "WeChat"' >/dev/null 2>&1
sleep 2
if pgrep -x WeChat >/dev/null; then
  echo "    微信仍在运行，请手动 Cmd+Q 后再跑本脚本"; exit 1
fi

echo "==> 第 2 步：启动副本（数据目录与原版相同）"
open -n "$COPY"
read -r -p "    在副本里完成登录（可能要手机确认），登录成功后回车开始取钥…" _

echo "==> 第 3 步：LLDB 捕获 300 秒"
echo "    期间请在微信里点开 3-5 个聊天；若结束时覆盖不足，退出登录再登录后重跑。"
sudo "$BUN" run "$ROOT/src/main.ts" key capture --seconds 300

echo "==> 第 4 步：校验"
"$BUN" run "$ROOT/src/main.ts" doctor

cat <<'EOF'

取钥结束。日常使用前可以：
  osascript -e 'quit app "WeChat"'; open -a /Applications/WeChat.app   # 回到原版
  wx sessions
EOF
