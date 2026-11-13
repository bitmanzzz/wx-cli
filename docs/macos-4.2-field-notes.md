# macOS / 微信 4.2 实操边界

这份文档记录 2026-11 在 Apple Silicon、macOS 26、微信 4.2.0 上实际处理时遇到的边界情况，作为 README 的补充，不替代通用安装和取钥流程。

## 签名与取钥

- 只在 `wx init` 生成的副本上重签。不要原地重签 `/Applications/WeChat.app`；如果已经改过，先用备份恢复官方包，再从副本取钥。
- 取钥成功后可以恢复并继续使用官方微信。日常查询依赖已保存的 `keys.json`，不依赖重签副本常驻。
- 旧版日志里的取钥命令可能是 `wx key extract`，当前入口以 `wx --help` 和 `scripts/keys.sh` 为准。当前可用动作是 `wx key capture` 或 `sudo bash scripts/keys.sh <秒数>`。
- 不要用 `wx --version` 判断代码是否升级。当前入口的版本字符串可能仍是 `0.1.0`，应同时检查 `readlink -f "$(command -v wx)"`、`git rev-parse HEAD` 和 `wx doctor`。

## 密钥文件

- 当前版本使用 `~/.wx-cli/keys.json`。旧的 `~/.wx-cli/all_keys.json` 可能只是历史残留，不能据此判断当前覆盖；用 `wx key list` 或 `wx doctor`。
- `keys.json`、`imagekey.json` 和明文缓存都属于本机机密，权限应为 `0600` 或更严格。
- 用 `sudo` 取钥时生成的 `capture.log` 可能是 `0644`。首次取钥后执行：

  ```bash
  sudo chmod 600 ~/.wx-cli/capture.log
  ```

- 不要把 `~/.wx-cli/` 放进 Git、云盘或发给其他 agent；另一台机器要单独安装和取钥。

## 查询与缓存

- `history` 或 `attachments` 报 `EPERM`，先检查运行进程是否有 `~/.wx-cli/cache` 的写权限。这个错误通常不是密钥错误，而是缓存无法写入。
- 多个进程共用同一份明文缓存时，避免同时写同一个账号目录；出现临时解密失败时，先停止并发查询再重试。
- 已保存密钥后，官方微信继续运行通常不影响查询；如果源库正在被微信改写导致暂时无法解密，稍后重试，不要写微信原始数据库。

## 附件与图片

- `attachments` 的 `md5` / `dat_path` 为 `null` 不只表示“图片未下载”。即使 `wx doctor` 显示 `unknown_shards: []`，也可能因为 `message_resource.db` 查不到对应资源行或该库暂时不可用。先检查 `wx key repair`，再检查资源表，不要直接把两张图片按时间猜测绑定到消息。
- 4.2 的附件文件命名不固定，常见裸名 `<md5>.dat`、`<md5>_h.dat`、`<md5>_t.dat` 和 `<md5>_t_M.dat` 都可能存在。
- 裸 `.dat` 可能是 `wxgf`/HEVC 流，`_h.dat` 可能是可直接使用的完整 JPEG。不要根据 `.dat` 后缀判断真实格式；先看文件头，优先用 `wx extract` 的 `format` 结果。
- V2 图片解码需要 image AES key。`wx extract --image-key <32hex[:xorhex]>` 只适合明确拿到并验证过 key 的情况；不要输出或提交 key。
- 用文件时间戳做人工兜底时只能作为线索，不能作为通用实现。把附件映射到消息应以 `message_resource.db` 的 md5 为准。

## 最小验收

```bash
wx doctor
wx key list
wx sessions -n 5
wx history "会话名" -n 20
wx attachments "会话名" -n 5
```

验收时同时检查输出里的 `meta.status`、`meta.unknown_shards` 和 `meta.chat_latest_timestamp`，不要只看命令退出码。
