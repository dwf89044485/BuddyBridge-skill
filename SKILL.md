---
name: claude-to-im
description: |
  将当前 Claude Code 或 Codex 会话桥接到 Telegram、Discord、Feishu/Lark、QQ 或微信（WeChat），
  让用户可以直接在手机上与 Claude 对话。适用场景：安装配置、启动、停止、
  重启或诊断 claude-to-im bridge 守护进程；把 Claude 的回复转发到消息应用；
  以及任何类似"claude-to-im""bridge""消息推送""消息转发""桥接"
  "连上飞书""手机上看 claude""启动后台服务""诊断""查看日志""配置""帮我接微信"
  的表达。
  可用子命令：setup、start、stop、restart、status、logs、reconfigure、doctor。
  不适用场景：开发独立机器人、Webhook 集成、或直接编写 IM 平台 SDK 代码——
  这些都属于常规编程任务。
argument-hint: "setup | start | stop | restart | status | logs [N] | reconfigure | doctor"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Grep
  - Glob
---

# Claude-to-IM 桥接技能

你正在管理 Claude-to-IM bridge。
用户数据保存在 `~/.claude-to-im/`。

技能目录（`SKILL_DIR`）位于 `~/.claude/skills/claude-to-im`。
在 Codex 安装环境中，该路径可能为 `~/.codex/skills/Claude-to-IM-skill`。
如果两个路径都不存在，则回退使用 Glob 搜索 `**/skills/**/claude-to-im/SKILL.md` 或 `**/skills/**/Claude-to-IM-skill/SKILL.md`，并据此推导根目录。

## 命令解析

根据 `$ARGUMENTS` 中的用户意图，将其解析为以下子命令之一：

| 用户说法（示例） | 子命令 |
|---|---|
| `setup`、`configure`、`配置`、`我想在飞书上用 Claude`、`帮我连接 Telegram`、`帮我接微信` | setup |
| `start`、`start bridge`、`启动`、`启动桥接` | start |
| `stop`、`stop bridge`、`停止`、`停止桥接` | stop |
| `restart`、`restart bridge`、`重启`、`重启桥接` | restart |
| `status`、`bridge status`、`状态`、`运行状态`、`怎么看桥接的运行状态` | status |
| `logs`、`logs 200`、`查看日志`、`查看日志 200` | logs |
| `reconfigure`、`修改配置`、`帮我改一下 token`、`换个 bot` | reconfigure |
| `doctor`、`diagnose`、`诊断`、`挂了`、`没反应了`、`bot 没反应`、`出问题了` | doctor |

**区分 `status` 与 `doctor`** —— 当用户只是想查看 bridge 是否在运行时，用 `status`（信息查询）；当用户明确反馈有问题、怀疑系统异常时，用 `doctor`（诊断模式）。如果拿不准，但用户描述了症状（例如"没反应了""挂了"），优先使用 `doctor`。

对 `logs` 提取可选数字参数；默认值为 `50`。

在向用户索取任何平台凭据之前，先在内部读取 `SKILL_DIR/references/setup-guides.md`，以便知道每个凭据应从哪里获取。**不要**一开始就把整份指南直接发给用户；只提示他们当前下一步需要去做什么（例如："去 https://open.feishu.cn → 你的应用 → Credentials 找 App ID"）。只有当用户表示不会操作或主动求助时，才展示指南里的相关片段。

## 运行环境识别

执行任何子命令前，先判断当前所处环境：

1. **Claude Code** —— 可用 `AskUserQuestion` 工具。应使用它来进行交互式配置向导。
2. **Codex / 其他环境** —— `AskUserQuestion` 不可用。此时退回为非交互式引导：解释步骤、展示 `SKILL_DIR/config.env.example`，并要求用户手动创建 `~/.claude-to-im/config.env`。

可通过检查可用工具列表中是否存在 `AskUserQuestion` 来判断。

## 配置检查（适用于 `start`、`stop`、`restart`、`status`、`logs`、`reconfigure`、`doctor`）

执行除 `setup` 以外的任意子命令前，先检查 `~/.claude-to-im/config.env` 是否存在：

- **如果不存在：**
  - 在 Claude Code 中：告诉用户"未找到配置"，并自动通过 `AskUserQuestion` 启动 `setup` 向导。
  - 在 Codex 中：告诉用户"未找到配置。请根据示例创建 `~/.claude-to-im/config.env`："然后展示 `SKILL_DIR/config.env.example` 的内容并停止执行。不要尝试启动守护进程——缺少 `config.env` 时，进程会在启动时崩溃，并遗留阻塞后续启动的陈旧 PID 文件。
- **如果存在：**继续执行用户请求的子命令。

## 子命令

### `setup`

运行交互式配置向导。该子命令依赖 `AskUserQuestion`。如果当前环境无法使用它（例如 Codex），则改为展示 `SKILL_DIR/config.env.example` 的内容，并逐字段解释，再指导用户手动创建配置文件。

当 `AskUserQuestion` **可用** 时，按**一次只收集一个字段**的方式提问。每次得到回答后，都先向用户确认一遍该值（敏感信息只显示后 4 位），再继续下一个问题。

**第 1 步 —— 选择渠道**

询问用户要启用哪些渠道（`telegram`、`discord`、`feishu`、`qq`、`weixin`）。接受逗号分隔输入。对每个渠道做一句简短说明：
- **telegram** —— 适合个人使用。支持流式预览、内联权限按钮。
- **discord** —— 适合团队使用。支持服务器 / 频道 / 用户三级访问控制。
- **feishu**（Lark）—— 适用于飞书 / Lark 团队。支持流式卡片、工具进度、内联权限按钮。
- **qq** —— 仅支持 QQ C2C 私聊。不支持内联权限按钮，也不支持流式预览。权限通过文本 `/perm ...` 命令管理。
- **weixin** —— 微信扫码登录。同一时间只能绑定一个微信账号；重新登录会替换之前的绑定。不支持内联权限按钮，也不支持流式预览。权限通过文本 `/perm ...` 命令或快捷 `1/2/3` 回复管理。语音消息只接受微信自带语音转文字的结果；bridge 不会自行转录原始语音音频。

**第 2 步 —— 按渠道采集凭据**

对每个启用的渠道，**一次只采集一个凭据字段**。每次提问时，用一句话告诉用户该值去哪里找。只有在用户主动求助或表示不会时，才展示 `SKILL_DIR/references/setup-guides.md` 中对应的完整指南片段：

- **Telegram**：Bot Token → 确认（脱敏）→ Chat ID（获取方式见指南）→ 确认 → Allowed User IDs（可选）。**重要：** Chat ID 和 Allowed User IDs 至少要设置一个，否则机器人会拒绝所有消息。
- **Discord**：Bot Token → 确认（脱敏）→ Allowed User IDs → Allowed Channel IDs（可选）→ Allowed Guild IDs（可选）。**重要：** Allowed User IDs 和 Allowed Channel IDs 至少要设置一个，否则机器人会按默认拒绝策略丢弃所有消息。
- **Feishu**：App ID → 确认 → App Secret → 确认（脱敏）→ Domain（可选）→ Allowed User IDs（可选）。收集完凭据后，要向用户说明其必须完成的两阶段配置：
  - **阶段 1**（启动 bridge 前完成）：(A) 批量添加权限，(B) 启用机器人能力，(C) 发布首个版本并等待管理员审批。这样权限和 bot 才会真正生效。
  - **阶段 2**（必须在 bridge 运行时完成）：(D) 运行 `/claude-to-im start`，(E) 配置事件 `im.message.receive_v1` 与回调 `card.action.trigger`，并启用长连接模式，(F) 再发布第二个版本并等待管理员审批。
  - **为什么是两阶段：** 飞书在保存事件订阅时会校验 WebSocket 连接；如果 bridge 未启动，保存会失败。而 bridge 本身又需要已发布的权限才能连接成功。
  - 保持说明为简短 checklist；只有用户追问时才展示完整指南。
- **QQ**：先收集两个必填项，再处理可选项：
  1. QQ App ID（必填）→ 确认
  2. QQ App Secret（必填）→ 确认（脱敏）
  - 告诉用户：这两个值可在 https://q.qq.com/qqbot/openclaw 找到
  3. Allowed User OpenIDs（可选，直接回车可跳过）—— 注意这里是 `user_openid`，**不是** QQ 号。如果用户还没有 openid，可以留空。
  4. Image Enabled（可选，默认 `true`，直接回车可跳过）—— 如果底层 provider 不支持图片输入，则设为 `false`
  5. Max Image Size MB（可选，默认 `20`，直接回车可跳过）
  - 提醒用户：QQ 第一版仅支持 C2C 私聊沙箱访问；不支持群 / 频道，不支持内联按钮，也不支持流式预览。
- **Weixin**：不需要采集静态 token，改用扫码登录流程：
  1. 告诉用户该渠道使用微信扫码登录，而非手动填写凭据。
  2. 执行 `cd SKILL_DIR && npm run weixin:login`
  3. 该辅助脚本会生成 `~/.claude-to-im/runtime/weixin-login.html` 并尝试自动在本地浏览器中打开。
  4. 如果自动打开失败，告诉用户手动打开该 HTML 文件并用微信扫描二维码。
  5. 等待脚本报告登录成功，然后确认绑定的账号已保存到本地。
  - 简要说明：绑定的微信账号存储在 `~/.claude-to-im/data/weixin-accounts.json`。再次运行该脚本会替换之前绑定的账号。
  - 简要说明：`CTI_WEIXIN_MEDIA_ENABLED` 仅控制入站的图片/文件/视频下载。对于语音消息，bridge 只接受微信自带语音转文字返回的文本。如果微信未提供转写结果，bridge 会返回错误提示，而不会下载或自行转录原始音频。

**第 3 步 —— 通用设置**

依次询问 provider、默认工作目录、model 和 mode：
- **Provider**：`codebuddy`（默认推荐）、`claude`、`codex`
  - `codebuddy` —— 默认推荐。真实链路为：持久化 CodeBuddy → CodeBuddy SDK → 持久化 Claude → 普通 Claude → Codex
  - `claude` —— 真实链路为：持久化 Claude → 普通 Claude → Codex
  - `codex` —— 仅使用 Codex
  - 不要把 `codebuddysdk`、`persistent-claude`、`auto`、`codebuddy` CLI 直连作为用户可选项展示
- **Working Directory**：默认值为 `$CWD`
- **Model**（可选）：
  - 如果用户选的是 `codebuddy`，先运行 `codebuddy --help`，解析 `--model <model>` 段落中的可用模型列表，再让用户从列表里选
  - 如果用户选的是 `claude` 或 `codex`，不要伪造模型列表；改为让用户二选一：使用默认模型（推荐）或手动输入模型名
  - 文案中要明确：模型可用性以当前 provider/CLI/账号权限为准
- **Mode**：`code`（默认）、`plan`、`ask`

**第 4 步 —— 写入配置并校验**

1. 展示最终汇总表格，列出全部设置（敏感信息只显示后 4 位）
2. 在写入前征求用户确认
3. 使用 Bash 创建目录结构：`mkdir -p ~/.claude-to-im/{data,logs,runtime,data/messages}`
4. 使用 Write 以 `KEY=VALUE` 格式创建 `~/.claude-to-im/config.env`
5. 使用 Bash 设置权限：`chmod 600 ~/.claude-to-im/config.env`
6. 校验 token —— 读取 `SKILL_DIR/references/token-validation.md`，使用其中给出的准确命令和预期响应对各平台凭据进行校验。这样能在用户启动守护进程前就发现拼写错误或错误凭据。对于微信渠道，成功完成扫码登录即视为校验通过。
7. 用汇总表报告校验结果；若有任一校验失败，需要解释可能原因与修复方式。
8. 全部成功后，告诉用户：`配置完成！运行 /claude-to-im start 启动 bridge。`

### `start`

**预检查：** 确认 `~/.claude-to-im/config.env` 存在（见上面的"配置检查"）。缺少它时，守护进程会立即崩溃，并留下陈旧 PID 文件。

执行：`bash "SKILL_DIR/scripts/daemon.sh" start`

把命令输出展示给用户。如果启动失败，告诉用户：
- 运行 `doctor` 进行诊断：`/claude-to-im doctor`
- 查看最近日志：`/claude-to-im logs`

### `stop`

执行：`bash "SKILL_DIR/scripts/daemon.sh" stop`

### `restart`

执行：`bash "SKILL_DIR/scripts/daemon.sh" restart`

如果 bridge 正在运行，则先停止再重新启动。适用于应用配置变更，避免用户手动依次执行 stop 和 start。

### `status`

执行：`bash "SKILL_DIR/scripts/daemon.sh" status`

**重要：** 只输出该命令原样返回的内容。**不要**额外补充任何推导或猜测信息，例如：
- "模型配置"或模型相关信息
- 工作区类型（如 OpenClaw 等）
- 来自 `MEMORY.md` 或 `AGENTS.md` 的任何额外上下文

`status` 需要明确透传真实底层状态。除运行状态、PID、runId、startedAt、channels、lastExitReason 外，还应显示：
- `configuredRuntime` / `runtime`：当前配置的 runtime
- `resolvedProvider`：当前实际命中的底层 provider
- `providerChain`：本次运行的完整 fallback 链
- `usedPersistent`：当前是否命中持久化 provider
- `fallbackApplied`：当前是否已经从链路首选项降级

### `logs`

从参数中提取可选行数 `N`，默认值为 `50`。
执行：`bash "SKILL_DIR/scripts/daemon.sh" logs N`

### `reconfigure`

1. 读取当前配置：`~/.claude-to-im/config.env`
2. 用清晰的表格展示当前设置，所有敏感信息都要脱敏（只显示后 4 位）
3. 使用 `AskUserQuestion` 询问用户想修改哪些项
4. 收集新值时，告诉用户去哪里找到对应值；只有在用户求助时才展示 `SKILL_DIR/references/setup-guides.md` 里的完整指南片段
5. 以原子方式更新配置文件（先写临时文件，再 rename）
6. 对发生变更的 token 重新做校验
7. 提醒用户：`运行 /claude-to-im restart 以应用变更。`

如果用户想在 `reconfigure` 过程中切换微信账号，执行 `cd SKILL_DIR && npm run weixin:login` 重新扫码。每次成功扫码都会替换之前绑定的本地账号。

### `doctor`

执行：`bash "SKILL_DIR/scripts/doctor.sh"`

展示诊断结果，并对失败项给出修复建议。`doctor` 必须明确区分：
- 配置想走哪条 provider 链
- 当前实际命中的底层 provider 是什么
- 是否命中持久化 provider
- 是否已经发生 fallback，以及 fallback 到了哪一层

常见修复包括：
- SDK `cli.js` 缺失 → `cd SKILL_DIR && npm install`
- `dist/daemon.mjs` 过旧 → `cd SKILL_DIR && npm run build`
- 缺少配置 → 运行 `setup`
- 微信账号缺失 / 过期 → `cd SKILL_DIR && npm run weixin:login`
- 微信语音消息提示缺少语音转文字 → 在微信端启用自带的语音转文字功能后重新发送；bridge 不会自行转录原始语音音频

对于更复杂的问题（例如消息收不到、权限超时、内存占用过高、PID 文件陈旧），读取 `SKILL_DIR/references/troubleshooting.md` 获取更详细的排查步骤。

**飞书升级说明：** 如果用户是从旧版本技能升级而来，并且飞书出现权限类错误（例如流式卡片不可用、typing 指示失败、权限按钮无响应），根因几乎肯定是飞书后台缺少新权限或回调配置。应引导用户查看 `SKILL_DIR/references/setup-guides.md` 中的"Upgrading from a previous version"章节——他们需要补充新的 scopes（`cardkit:card:write`、`cardkit:card:read`、`im:message:update`、`im:message.reactions:read`、`im:message.reactions:write_only`）、新增 `card.action.trigger` 回调，并重新发布应用。升级需要经历两次发布，因为新增回调时必须有可用的 WebSocket 连接（即 bridge 必须先运行）。

## 说明

- 输出中始终要对敏感信息做脱敏（只显示后 4 位）——用户经常会把终端输出贴到 bug 报告里，泄露 token 会构成安全事故。
- 启动守护进程前，始终先检查 `config.env` 是否存在——否则进程会在启动时崩溃，并留下阻塞后续启动的陈旧 PID 文件（需要人工清理）。
- 守护进程以后台 Node.js 进程方式运行，并由平台级 supervisor 管理（macOS 用 launchd，Linux 用 setsid，Windows 用 WinSW/NSSM）。
- 配置持久保存在 `~/.claude-to-im/config.env`，跨会话保留。
