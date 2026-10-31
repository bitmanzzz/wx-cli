# wx — 本地微信数据 CLI（macOS）

从命令行读取**本机已登录账号**的微信 4.x 数据：会话、聊天记录、搜索、联系人、群成员、统计、导出、图片附件、朋友圈、公众号、收藏。输出 JSON（可选 YAML），供人和 AI agent 直接消费。

**只读**：不写微信目录、不发消息、不联网。

---

## 1. 前提

| 项 | 要求 |
|---|---|
| 系统 | macOS（Apple Silicon 实测；Intel 未验证） |
| 微信 | 4.x 桌面版，**已登录**（4.1.15 与 4.2.0 实测可用） |
| 运行时 | [Bun](https://bun.sh) ≥ 1.2 |
| 权限 | 取钥那一步需要本机 GUI 终端 + `sudo` 密码 |

不需要：关闭 SIP、给微信重新签永久签名、常驻后台进程。

## 2. 安装（每台 Mac 各做一次）

```bash
git clone <本仓库> ~/wx && cd ~/wx
bash scripts/install.sh          # 把 wx 链到 ~/.local/bin
```

## 3. 取钥（每台 Mac 各做一次）

微信 4.x 的数据库是 SQLCipher 加密的，密钥只存在于**正在运行的微信进程**里；官方包带 hardened runtime，普通进程无法读写它的内存，所以要「复制一份 + ad-hoc 重签 + 调试器附加」。

```bash
# 1) 生成副本（原版 /Applications/WeChat.app 不动，约 1.4G）
wx init

# 2) 退出原版微信，启动副本并登录
osascript -e 'quit app "WeChat"'
open -n ~/.wx-cli/WeChat.app

# 3) 取钥（180 秒；期间点开几个聊天）
sudo bash scripts/keys.sh 180

# 4) 验证
wx doctor          # status: ok 即成功
```

取钥做的是：附加上副本进程 → 在 `CCKeyDerivationPBKDF` 下断点 → 抓每个库的页密钥（以及登录时的 passphrase）→ 用首页 HMAC 逐个校验 → 写入 `~/.wx-cli/keys.json`。

日常使用不需要再取钥，也不需要微信一直开着（缓存过期时才重新解密）。

## 4. 命令

完整的「能查到什么、字段含义、查询配方」见 **[docs/what-you-can-query.md](docs/what-you-can-query.md)**。

```bash
wx doctor                              # 环境 / 密钥覆盖 / 缓存
wx sessions -n 20                      # 最近会话（--filter private,group）
wx unread                              # 有未读的会话
wx new-messages                        # 上次检查后的新消息（--peek 不推进游标）
wx history "张三" -n 200                # 聊天记录
wx history "AI群" --since 2026-04-01 --until 2026-04-15 --type image
wx search "关键词" --in "工作群"         # 全库搜索（message_fts + 分片回退）
wx stats "AI群"                        # 总量、时间跨度、发言排行、类型分布
wx timeline --since 2026-10-01 -n 100  # 跨会话时间线（--after/--before 翻页、--type 过滤）
wx watch --interval 1500               # 实时监听新消息（NDJSON，Ctrl-C 退出；--once 单次）
wx export "张三" -f markdown -o chat.md # markdown / json / jsonl
wx contacts --query 李
wx members "AI群"                      # 群成员（含 is_owner）
wx attachments "AI群" -n 50            # 图片附件 → attachment_id
wx extract <attachment_id> -o a.jpg    # 解出原图（V1 / V2 / legacy XOR）
wx media "AI群" -n 20                  # 语音列表
wx media extract <id> -o a.silk --wav  # 导出语音（--wav 需先装 silk-v3-decoder）
wx sns-feed --user 张三 --since 2026-01-01
wx sns-search 婚礼
wx sns-notifications                   # 点赞/评论通知（--include-read）
wx biz-articles --account 返朴
wx favorites --type article --query 关键词
```

公共选项：`--account <id>`、`--limit/-n`、`--since`、`--until`、`--yaml`。

调试用：`wx tables`、`wx schema <db>`、`wx raw <db> "<SQL>"`、`wx key list`、`wx key repair`。

## 5. 输出约定

- 默认 JSON；`--yaml` 切换
- `history` / `search` / `sessions` / `stats` / `attachments` 带 `meta`：

| 字段 | 含义 |
|---|---|
| `meta.status` | `ok` / `windowed` / `possibly_stale` / `possibly_stale_unknown_shards` |
| `meta.unknown_shards` | 磁盘上有、但当前没有密钥的库（非空说明需要补钥） |
| `meta.session_last_timestamp` | `session.db` 记录的最新时间，用于判断是否漏消息 |
| `meta.chat_latest_timestamp` | 本次结果里最新一条消息的时间 |

- 群消息带稳定身份三件套：`sender_username`（wxid）、`sender_contact_display`、`sender_group_nickname`
- `attachment_id` 是 base64url 的 JSON（`v/chat/local_id/create_time/kind/db`），可跨命令传递

## 6. 使用规则（重要）

1. **只读**。任何命令都不会写微信的数据目录；`~/.wx-cli/cache/` 里的明文库是副本，可随时删。
2. **密钥是本机机密**。`~/.wx-cli/keys.json`、`capture.log`、`imagekey.json`、`cache/` 一律**不要提交、不要同步到云盘、不要发给别人**。它们能解开你所有微信数据。
3. **密钥不能跨机复用**。每台 Mac 的数据库 salt 与密钥都不同，换机必须重新取钥。
4. **只处理自己的账号**。工具设计目标是自己的数据，不提供任何绕过他人设备的路径。
5. **导出结果含隐私**。`wx export`、`wx extract` 的产物请自行控制存放位置与权限。
6. 取钥脚本会对副本开展调试；副本仅用于取钥，用完可以留在 `~/.wx-cli/WeChat.app`，也可以删掉（下次取钥再 `wx init`）。

## 7. 多台 Mac 上使用

| 场景 | 做法 |
|---|---|
| 新机器 | 安装 → `wx init` → 登录副本 → `sudo bash scripts/keys.sh 180` → `wx doctor` |
| 微信小版本升级 | 密钥通常仍有效；若 `doctor` 报缺库，重跑 `scripts/keys.sh` |
| 微信重建了数据库（salt 变化） | `wx key repair`（用已存的 passphrase 自动重新派生） |
| 换了/退出登录了账号 | 该账号需要重新取钥；`wx doctor` 会显示活跃账号的覆盖情况 |
| 另一台机器上用同一份代码 | 代码可以共用，`~/.wx-cli` **不要**共用 |

## 8. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `wx doctor` → status incomplete | 活跃账号有库缺钥：`sudo bash scripts/keys.sh 60`，期间点开聊天 |
| 取钥后 `candidates 0` | 断点没命中：确认微信已登录且是副本进程；重新跑并点开聊天 |
| 微信界面完全无响应、`kill` 无效 | 被 lldb 留在暂停态：`sudo /usr/bin/lldb --batch -o "process attach -p <pid>" -o "process detach" -o "quit"` |
| `unable to open database file` | 明文库是 WAL 头：删掉 `~/.wx-cli/cache/<账号>` 重跑（代码已自动转 rollback 模式） |
| `database disk image is malformed` | 解密参数不对（多为 reserve 字节被清零）：更新代码后删缓存重跑 |
| `database disk image is malformed`（sns/biz） | 同上，删除 `~/.wx-cli/cache` 后重试 |
| `attachments` 里 `dat_path` 为 null | 图片未被微信下载过，或 `message_resource.db` 密钥过期 → `wx key repair` |
| `media` 列表为空 | 该会话没有语音，或 `message/media_0.db` 缺密钥（`wx doctor` 看覆盖） |
| `media extract --wav` 报缺解码器 | 装 [silk-v3-decoder](https://github.com/kn007/silk-v3-decoder)；不加 `--wav` 则直接落 `.silk` |
| `extract` 报需要 image AES key | 该图是 V2 格式但 `kvcomm` 里没有可用 uin：先用 `--image-key <32hex[:xorhex]>` 手工指定 |
| 读文件/`ls` 长时间挂住 | 可能有被调试器卡住的微信进程占着容器：先 `kill -9` 它，或重启微信 |

## 9. 原理简述

- **SQLCipher 4**：page 4096、reserve 80（IV 16 + HMAC-SHA512 64）、页密钥为 32B raw key
- **passphrase → 页密钥**：`PBKDF2-HMAC-SHA512(passphrase, db_salt, 256000, 32B)`
- **HMAC 校验**：`HMAC-SHA512(PBKDF2(page_key, salt^0x3a, 2), page1[16:4032] + pgno)`
- **表定位**：每个会话一张 `Msg_<md5(username)>`，按 `message_N.db` 分片；发送者由分片内 `Name2Id` 解析
- **缓存**：db + wal 一起解密 → `wal_checkpoint(TRUNCATE)` → 转 rollback 模式 → 按源文件 mtime/size 失效
- **附件**：`message_resource.db` 给出 md5 → `msg/attach/<md5(chat)>/<YYYY-MM>/Img/<md5>_t_M.dat` → 解码（legacy XOR / V1 固定 AES / V2 AES+XOR）

## 10. 开发

```bash
bun test          # 25 个用例：加密参数、WAL、取钥匹配、缓存、附件解码、端到端
```

测试用 `sqlcipher`（`brew install sqlcipher`）现场生成加密库做真值校验；未安装时相关用例自动跳过。`test/e2e.test.ts` 用合成明文库跑通 sessions/history/search/stats/export/attachments 全链路。

目录：

```
src/main.ts            CLI 入口与命令分发
src/core/              账号发现、加解密、WAL、缓存、名称解析、消息解析、附件、image key
src/cli/               sessions / messages / lists / media / extras / export
src/keys/              lldb 捕获器与 Python 断点回调
scripts/               install.sh、keys.sh、bootstrap.sh
```

版本差异记录见 §9 与 README 末尾的实测条目；升级微信后优先看 `wx doctor` 与 `~/.wx-cli/capture.log`。

---

## 附：本机实测结论（4.2.0 / macOS 26）

- 断点只能挂 `CCKeyDerivationPBKDF`（每库一次）；`CCCryptorCreate` / `CCCrypt` 是逐页调用，挂上会让微信冻结到 `T` 状态。
- 登录过程中可抓到 `rounds=256000` 的 passphrase，存盘后 `wx key repair` 能从 `capture.log` 重建任意库的密钥。
- 4.2 的 `.dat` 主流命名是 `<md5>_t_M.dat`，`_t` / `_h` / 裸名也存在。
- Bun 的 SQLite 只读打开 WAL 头数据库会失败，需先 `PRAGMA journal_mode=DELETE`。
- 解密时不能把 header offset 20 的 reserve 字节清零，否则 SQLite 报 `fragmentation` / `malformed`。
