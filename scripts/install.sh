#!/bin/bash
# 新机器一次性安装：检查 bun、把 wx 链到 PATH、打印下一步
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

if ! command -v bun >/dev/null 2>&1; then
  echo "缺少 Bun。安装：curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
echo "bun: $(bun --version)"

mkdir -p "$BIN_DIR"
ln -sf "$ROOT/src/main.ts" "$BIN_DIR/wx"
chmod +x "$ROOT/src/main.ts" "$ROOT/scripts/"*.sh

echo "已链接：$BIN_DIR/wx -> $ROOT/src/main.ts"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "PATH 已包含 $BIN_DIR" ;;
  *) echo "请把 $BIN_DIR 加入 PATH，例如：echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc" ;;
esac

"$BIN_DIR/wx" doctor || true
cat <<'EOF'

下一步（只在本机做一次）：
  1) 确认微信已登录：open -a WeChat
  2) 准备 ad-hoc 副本：wx init
  3) 退出微信、启动副本并登录：open -n ~/.wx-cli/WeChat.app
  4) 取钥：sudo bash scripts/keys.sh 180（期间点开几个聊天）
  5) 验证：wx doctor
EOF
