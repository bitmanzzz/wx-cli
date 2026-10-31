# AGENTS.md — 在本仓库/本工具上工作的约定

面向 AI agent。人类使用说明见 `README.md`。

## 工具契约

- 入口：`wx <command> [options]`，默认输出 JSON；需要 YAML 用 `--yaml`。
- 读结果前先看 `meta.status`：
  - `ok` 可直接用
  - `windowed` 表示调用方传了 `--since/--until/--offset/--type`，结果只是切片
  - `possibly_stale` / `possibly_stale_unknown_shards` 表示可能漏数据，先看 `meta.unknown_shards`
- 会话解析：可以用备注名、微信昵称或 username。同名多结果时命令会报错并列出候选，此时改用 username。
- 附件：先用 `wx attachments <会话>` 拿 `attachment_id`，再 `wx extract <id> -o <路径>`；`dat_path` 为 null 说明本机没有该文件。
- 调试：`wx tables` 看表名、`wx schema <db>` 看结构、`wx raw <db> "<SQL>"` 跑任意查询。

## 安全红线

1. 只读微信数据目录；不要写、不要改、不要 checkpoint 微信自己的库。
2. `~/.wx-cli/` 下的一切（`keys.json`、`capture.log`、`imagekey.json`、`cache/`）都是机密：不得提交到仓库、不得上传、不得贴进对话或工单。
3. 不要在未授权的情况下对他人账号/设备取数。
4. 需要导出结果时，落盘位置由用户指定，不要默认放公共目录。

## 修改代码时

- 改动加解密、WAL、附件解码后必须跑 `bun test`；遇到真机格式差异，先加用例再改实现。
- 不要为提高覆盖率引入真实微信数据作为测试夹具；用 `sqlcipher` 现场生成加密库。
- 取钥链路（`src/keys/`）宁慢勿快：断点只能挂在每库调用一次的函数上，逐页调用的函数（`CCCryptorCreate`、`CCCrypt`）会让微信 UI 卡死。
- 新增命令遵循现有输出风格：顶层 `{ ..., meta }`，字段同时给机器可读 id 与人类可读展示名。
