# 能查到什么、怎么查

本文档说明 `wx` 能从本机微信数据里取到哪些信息、对应的命令与字段，以及常见查询配方。

> 所有示例均为结构示例，正文内容用占位符代替；实际输出里是你本机的真实数据。

---

## 1. 数据总量（本机实测，微信 4.2.0）

| 数据 | 数量 | 来源库 |
|---|---|---|
| 会话 | 1,057 | `session/session.db` → `SessionTable` |
| 消息 | 122,197 条 / 1,097 个会话表 | `message/message_0..4.db` → `Msg_<md5(username)>` |
| 全文索引 | 109,938 条 | `message/message_fts.db` → `message_fts_v4_N_content` |
| 联系人 | 4,246 | `contact/contact.db` → `contact` |
| 群 | 103 | `chat_room` |
| 群成员关系 | 3,270 | `chatroom_member` |
| 联系人标签 | 35 | `contact_label` |
| 附件资源 | 8,852（详情 18,474） | `message_resource.db` |
| 收藏 | 50 | `favorite/favorite.db` → `fav_db_item` |
| 朋友圈 | 144 条时间线 | `sns/sns.db` → `SnsTimeLine` |
| 公众号 | 39 个账号的文章推送 | `message/biz_message_N.db` |

---

## 2. 按问题选命令

| 你想知道 | 命令 |
|---|---|
| 谁最近找我 / 有没有未读 | `wx sessions -n 20`、`wx unread` |
| 上次检查后有什么新消息 | `wx new-messages`（`--peek` 不推进游标） |
| 和某人/某群聊了什么 | `wx history "张三" -n 200` |
| 某段时间的记录 | `wx history "AI群" --since 2026-10-01 --until 2026-10-31` |
| 只找图片 / 链接 / 文件 / 语音 | `wx history "AI群" --type image\|link\|file\|voice` |
| 关键词在哪儿出现过 | `wx search "合同"`、`wx search "合同" --in "客户群"` |
| 群里谁最活跃、都发什么 | `wx stats "AI群"` |
| 今天所有会话里都发生了啥 | `wx timeline --since 2026-10-31 -n 200` |
| 有新消息就推给我 | `wx watch --interval 1500`（每行一条 JSON，可管道给 `jq`） |
| 语音消息 | `wx media "AI群"` → `wx media extract <id> -o a.silk` |
| 把一段对话存档 | `wx export "张三" -f markdown -o chat.md` |
| 通讯录、标签、群主 | `wx contacts --query 李`、`wx members "AI群"` |
| 聊天里的原图 | `wx attachments "AI群" -n 50` → `wx extract <attachment_id> -o a.jpg` |
| 朋友圈谁发了什么、谁点赞 | `wx sns-feed --user 张三`、`wx sns-search 婚礼` |
| 公众号推送了哪些文章 | `wx biz-articles --account 返朴` |
| 我收藏过什么 | `wx favorites --type article --query 关键词` |
| 原始 SQL 兜底 | `wx tables`、`wx schema <db>`、`wx raw <db> "SELECT ..."` |

---

## 3. 字段字典

### sessions / unread

```json
{
  "username": "12345678901@chatroom",
  "display": "客户群",
  "chat_type": "group",            // private | group | official_account | folded
  "unread": 3,
  "last_timestamp": 1792810586,
  "last_time": "2026-10-24 10:56:26",
  "last_msg_type": 1,              // 复合类型，低 32 位有效
  "last_sender": "李四",            // 群聊优先群昵称
  "summary": "报价单明天发你"
}
```

### history

```json
{
  "timestamp": 1792810586,
  "time": "2026-10-24 10:56:26",
  "sender": "李四",
  "sender_username": "wxid_xxx",          // 稳定 wxid，同名靠它区分
  "sender_contact_display": "李四（备注/昵称）",
  "sender_group_nickname": "",            // 4.2 起多为空
  "content": "[链接] 合同模板",
  "type": "链接/文件",
  "type_id": "appmsg",                    // text/image/voice/video/appmsg/system/revoke…
  "type_code": 49,
  "appmsg_type": 6,                       // 6=文件 5=链接 57=引用 19=聊天记录 33/36=小程序
  "url": "https://…",
  "local_id": 42
}
```

引用消息会展开成两行：

```
[引用] 收到，明天处理
  ↳ 张三: 合同盖章了吗
```

### search

`search` 的结果是 `messages` 的同构体 + `chat` / `chat_display`；`source` 说明走的哪条路（`message_fts` 或 `shards`）。

### stats

```json
{
  "total": 190,
  "first_time": "2024-11-23 22:51:06",
  "last_time": "2026-10-24 10:56:26",
  "top_senders": [{ "sender": "李四", "count": 99 }],
  "by_type": { "text": 149, "image": 26, "appmsg": 11, "system": 4 }
}
```

### attachments / extract

```json
{
  "attachment_id": "eyJ2IjoxLC…",
  "kind": "image", "type": "image",
  "local_id": 7, "timestamp": 1729216769, "time": "2024-10-18 09:59:29",
  "md5": "50fe7038ac4e2e304347db6af845f0bd",
  "dat_path": "/…/msg/attach/<md5(chat)>/2024-10/Img/<md5>_t_M.dat",
  "sender": "李四"
}
```

`extract` 返回 `format`（jpg/png/gif/webp/bmp/tif/hevc）、`decoder`（`v1`/`v2`/`legacy_xor`）、`output_size`。

### members

```json
{ "username": "wxid_xxx", "contactDisplay": "李四", "groupNickname": "", "isOwner": false }
```

### timeline / watch / media

```json
// wx timeline
{ "timestamp": 1793262014, "chat": "wxid_xxx", "chat_display": "张三",
  "chat_type": "private", "sender": "张三", "content": "在吗" }

// wx watch（NDJSON，一行一条）
{"timestamp":1793262014,"chat":"…","chat_display":"…","content":"…"}

// wx media
{ "attachment_id": "eyJ2Ijox…", "kind": "voice", "local_id": 51575,
  "timestamp": 1748586833, "size": 4963, "data_index": 0 }
```

- `timeline` 只合并 `message_N.db`（普通会话）；公众号文章走 `biz-articles`，不混进时间线
- `timeline --after <时间>` 向新翻页、`--before <时间>` 向旧翻页
- `watch` 轮询 `session.db` 的 `last_timestamp`，间隔默认 1500ms；`--once` 适合 cron
- `media` 导出的是 **SILK v3**（`\x02#!SILK_V3` 头）；`--wav` 需要本机有 `silk-v3-decoder`

### 朋友圈 / 公众号 / 收藏

- `sns-feed`：`tid`(字符串)、`author`、`content`、`timestamp`、`location`、`media[]`（含 `url`/`thumb`/`md5`/`key`/`token`/`width`/`height`）
- `biz-articles`：`account`、`title`、`url`、`digest`、`cover_url`、`timestamp`
- `favorites`：`type`（text/image/article/card/video）、`content`（已从 XML 提取为纯文本）、`url`、`from_user`、`time`

---

## 4. 查询配方（可直接抄）

```bash
# 最近 3 天有哪些人找我，带未读数
wx sessions -n 200 | jq -r '.sessions[] | select(.last_timestamp > (now - 3*86400)) | "\(.last_time)  \(.display)  未读\(.unread)"'

# 某群这个月的全部消息导出成 Markdown
wx export "客户群" --since 2026-10-01 --until 2026-10-31 -f markdown -o oct.md

# 谁在群里发言最多
wx stats "客户群" | jq -r '.top_senders[:5][] | "\(.count)\t\(.sender)"'

# 全库找出所有带链接的消息
wx history "客户群" --type link -n 500 | jq -r '.messages[] | select(.url) | "\(.time)\t\(.url)"'

# 只看文件消息（含文件名）
wx history "客户群" --type file -n 500 | jq -r '.messages[] | select(.type_id=="appmsg") | .content'

# 批量导出某群最近 50 张图
mkdir -p imgs && wx attachments "客户群" -n 50 | jq -r '.attachments[].attachment_id' \
  | while read -r id; do wx extract "$id" -o "imgs/$id.jpg" --overwrite; done

# 跨会话时间线：最近 200 条，只看文本和链接
wx timeline -n 200 --since 2026-10-01 --type link

# 实时监听，只打印群消息标题
wx watch | jq -r 'select(.chat_type=="group") | "\(.time)  \(.chat_display)  \(.content[:60])"'

# 导出某人最近 20 条语音
mkdir -p voice && wx media "张三" -n 20 | jq -r '.voices[].attachment_id' \
  | while read -r id; do wx media extract "$id" -o "voice/$id.silk" --overwrite; done

# 每天的新消息（配合 cron：状态文件会自动推进）
wx new-messages | jq -r '.messages[] | "\(.time)  \(.chat_display)  \(.content[:60])"'

# 搜公众号文章里的关键词
wx biz-articles -n 500 | jq -r '.articles[] | select(.title|test("大促")) | "\(.time)  \(.account)  \(.title)\n  \(.url)"'
```

---

## 5. 拿不到 / 有边界的信息

| 项 | 说明 |
|---|---|
| 已删除的消息 | 微信本地删除后库里就没有了 |
| 未下载的媒体 | 图片/视频/文件只在微信客户端下载过才有 `.dat`；`dat_path` 为 null 即属此列 |
| 撤回消息的原文 | 只保留 `[撤回]` 提示 |
| 朋友圈 | 只有本机刷到过的帖子；互动通知依赖本机记录 |
| 公众号 | 只有推送历史，正文需按 `url` 自行抓取 |
| 语音转文字 | 不提供；`wx media` 只能导出 SILK 原始音频 |
| 公众号文章进 timeline | 不含：它们在 `biz_message_N.db`，用 `wx biz-articles` 查 |
| 群昵称 | 4.2 的 `chat_room.ext_buffer` 已不含昵称字段，回退到通讯录显示名 |
| 另一台设备/另一个账号 | 密钥按机器与账号隔离，需各自取钥 |

---

## 6. 使用规则（摘要，完整见 README §6）

1. 只读，不写微信目录。
2. `~/.wx-cli/`（密钥、日志、明文缓存）不出本机、不进仓库。
3. 密钥不跨机复用；换机重新取钥。
4. 导出结果含隐私，落盘位置自行控制。

---

## 7. 性能

热缓存下单条命令 70–90ms（会话/历史/搜索/统计）；首次访问某库需要解密，100MB 级库约 0.3s（实测 380MB/s），之后按源文件 mtime/size 复用缓存。
