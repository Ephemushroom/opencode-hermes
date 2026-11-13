# opencode-hermes(中文说明)

opencode 插件:把 Claude Code 风格的动态上下文事实以 `x-hermes-*` 请求头上报,
由 Hermes 网关解析后注入完整上下文块。V1 仅上报请求头；V2 还会在符合条件的
Claude 请求中，将 OpenCode 内置的临时目录建议同步为同一个 scratchpad 路径，不追加完整提示词块。

算法依据: Claude Code 2.1.214/2.1.220 静态分析 + 抓包实证
(见 `docs/gateway-contract.md` 附录说明)。

## 上报的请求头

| Header | 值 | 说明 |
|---|---|---|
| `x-hermes-context-version` | `"1"` | 契约版本,破坏性变更时递增 |
| `x-hermes-environment` | ASCII 安全 JSON | agent / cwd / isGitRepo / platform / shell / osVersion(模型信息不上报,网关从请求体 `model` 字段自取) |
| `x-hermes-scratchpad` | ASCII 安全 JSON | `{ "path": "..." }`,目录已落盘创建(0o700) |
| `x-hermes-context-management` | `"true"` | 该块是静态常量,网关持有 canonical 文本,这里只发开关 |
| `x-hermes-git-status` | ASCII 安全 JSON | `{ branch, mainBranch, user?, status, statusTruncated, recentCommits }`,**非 git 仓库整头省略** |

**ASCII 安全 JSON**: 所有非 ASCII 字符(如中文文件名)被转义为 `\uXXXX`,
防止 HTTP header 传输层的 latin-1 编码破坏 UTF-8。网关侧 `JSON.parse` /
`System.Text.Json` 原生还原,无需特殊处理。

## 安装与接线

在 opencode 配置中声明(全局 `~/.config/opencode/opencode.json` 或项目 `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@ephemushroom/opencode-hermes"]
}
```

opencode 启动时会用 Bun 自动安装 `plugin` 里声明的包,无需手动 npm install。

带选项:

```json
{
  "plugin": [["@ephemushroom/opencode-hermes", {
    "environment": true,
    "scratchpad": true,
    "contextManagement": true,
    "gitStatus": true,
    "gitTimeoutMs": 5000,
    "modelFilter": "claude",
    "extraEnvironment": { "team": "platform" }
  }]]
}
```

**改完配置需重启 opencode 生效**(配置不热加载)。

### OpenCode 2.0.6

从 v0.2.0 起，OpenCode 1 和 2 使用**同一个包名**。V2 使用原生 `plugins` 配置（复数）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@ephemushroom/opencode-hermes",
    "options": { "environment": true }
  }]
}
```

V2 适配器使用 `@opencode/plugin` **2.0.6**，上报环境上下文，并在请求级同步 scratchpad 建议（已通过 OpenCode **2.2.7** 隔离抓包验证）。工具发现与执行使用 OpenCode 原生 `execute` 和 Code Mode `search(...)`；Claude Code 的 ToolSearch 兼容层由 Hermes 的 `NativeBridge` 负责。插件不注册 ToolSearch、不维护别名或 eager/deferred 分类、不向会话投递搜索结果。原生 UA 和 `x-opencode-*` 身份头保持完整，供网关识别原生客户端。

从插件 **v0.3.0** 起，删除已废弃的 `toolSearchDelivery` 配置（旧值会被忽略）。先升级 Hermes 至 **v0.4.8 或更高版本**，再升级插件。V1 上下文适配器保留，要求客户端支持对象式 `server()` 加载。

根入口、`main` 和 `/server` 导出指向同一普通对象 `{ id, server, setup }`：V1 调用 `server`，V2 调用 `setup`，导入时不会启动任何适配器。[Effect 是可选形式](https://opencode.ai/v2/docs/build/plugins/)，本插件使用官方支持的 Promise API，无需重写为 Effect。

`/v2` 导出保留供代码直接导入；不要在当前 beta 的 `plugins` 配置中填写 npm `/v2` 后缀，它会被误判为本地路径。将旧配置项替换为裸包名，不要同时添加两项。原先直接调用默认函数的代码应改用具名 `HermesPlugin` 或 `default.server`。

升级后先结束正在运行的任务，执行 `opencode service restart` 后重新打开 V2 客户端。新请求应包含原生 `execute` 且不含插件注册的 ToolSearch。两个 SDK 仅用于类型声明，运行时代码不导入 SDK 或 Effect；Zod 是运行时依赖。

### 模型过滤

默认**仅当模型 ID 包含 `claude`(大小写不敏感)时才上报 header** —
kimi/gpt 等其他模型的请求一个头也不发,原样穿过网关。Bedrock/OpenRouter 风格
的 `anthropic.claude-*` / `anthropic/claude-*` 同样命中。选项 `modelFilter`
可改匹配子串,置 `""` 则不过滤、对所有模型上报。过滤使用每次请求的实际模型，
包括辅助请求和同一会话中的模型切换。

V2 提示词同步必须同时满足：实际模型 ID 含 `claude`，且匹配 `modelFilter`。
例如 `"sonnet"` 会缩小 Claude 范围；`"gpt"` 或 `""` 可以给其他模型发请求头，
但绝不会修改非 Claude 模型的提示词。所有匹配均不区分大小写。

## 环境变量

| 变量 | 作用 |
|---|---|
| `HERMES_CONTEXT_DISABLE=1`（或 `true`） | 整体停用，不发请求头、不改提示词 |
| `CLAUDE_CODE_TMPDIR` | scratchpad 临时根目录(对齐 Claude Code 语义) |

### Scratchpad 路径

结构为 `<root>/<base>/<项目名>-<hash>/<完整 sessionID>/scratchpad`:

- macOS 默认根目录为 `/tmp`，经 realpath 解析为 `/private/tmp`；Linux 和 Windows 使用 `os.tmpdir()`。非空 `CLAUDE_CODE_TMPDIR` 优先覆盖根目录。
- Unix 默认基目录为 `claude-<uid>`，Windows 为 `claude`。省略 `scratchpadDirName` 才会使用平台默认值；显式设置的名称原样使用，不追加 UID（包括显式 `"claude"`）。
- 项目分段保留中文等 Unicode，例如 `笔记Note-<8 位十六进制 hash>`。hash 是规范化绝对工作目录路径的 SHA-256 前 8 位小写十六进制，用于区分不同位置的同名项目；仅做词法路径规范化，不解析项目软链接。
- 文件系统非法字符替换为 `-`，去掉末尾点和空格，空名称或根目录使用 `root`。可读名称按 UTF-8 限制为 200 字节，不拆分 Unicode 码点；加上 hash 后整个分段最多 209 字节。
- session ID 保持完整。目录以 `0o700` 创建（受平台支持限制），请求头仍使用 ASCII 安全 JSON，解析后无损恢复中文路径。

此项目分段有意不同于 Claude Code 的全路径打平算法。不会迁移或删除旧目录，不改变会话缓存生命周期，也不会配置 OpenCode 访问权限白名单。

### V2 临时目录建议同步

符合条件的请求中，只替换 `core/environment` 的内置建议行：
`Prefer ... over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`
替换为 `Prefer <scratchpad 路径> for temporary work files instead of generic system temporary directories.`。
路径与 `x-hermes-scratchpad` 相同且已落盘，但不会声称 OpenCode 已预先批准访问。

必须有有效的 `metadata.experimental.instructions` 来源信息，唯一可识别的 core environment，
以及唯一的可见文本匹配。该 system part 必须仍与元数据中各来源文本用空行拼接的结果完全一致。
缺失/畸形元数据、重复候选、先前插件改过可见文本、或模板不匹配时均保持原样。
**不使用纯文本 fallback，不追加相互竞争的指令。** 老版本宿主不提供此实验元数据时，仍上报请求头，但不替换建议。

`context`、`compaction`、`generate`、`title` 使用同样规则；没有内置环境块的辅助请求不变。
这些钩子与 `model.request` 共享会话缓存中的实际路径，与触发顺序无关，提示词钩子不执行 git。
`scratchpad: false` 同时关闭目录创建、请求头和建议同步；停用开关、过滤未命中或创建目录失败也不会替换。

仅修改即将发出的 system 文本，不修改共享元数据、其他环境行、自定义/引用文本、用户消息、历史、原生身份或工具。
不改变 `Global.tmp`、`TMPDIR`、OpenCode 自身临时文件的位置或权限配置；访问 scratchpad 仍可能需要用户批准。
此请求级同步不依赖网关，完整上下文块的注入仍由网关负责。

## 目录结构

```
src/index.ts   插件入口: chat.headers 钩子 + 会话级缓存 + 选项
src/v2.ts      V2 适配器: 上下文请求头 + Claude 临时目录建议同步
src/lib.ts     共享逻辑: 可读 scratchpad 路径 / git 快照 / ASCII JSON
test/lib.test.ts  单测(bun test)
docs/gateway-contract.md  Hermes 网关处理文档(header 契约 + 注入算法 + C# 示例)
```

## 开发

```powershell
bun install
bun test           # bun 内置 runner,含对真实 git 仓库的快照冒烟
bun run typecheck  # tsc --noEmit(strict)
bun run build      # 打包 dist/index.js、dist/v2.js + 生成声明文件
```

运行时使用 Node/Bun 内建模块和 Zod；两个 SDK 的 `import type` 在转译期擦除，但包依赖保留以支持发布后的类型声明。

可选的隔离端到端抓包（需安装 OpenCode 2.2.7）：

```bash
bun run build
QA_OPENCODE_BIN=/path/to/opencode node test/v2-live-capture.mjs /path/to/approved/temp/root
```

脚本以独立 home/config/data/database 启动 `run --standalone` 私有服务和 localhost mock provider，
仅用虚假凭据，检查 Claude、非 Claude、停用请求及原生工具续轮。脱敏抓包和结果保存在指定临时根目录下，
结束后清理自己创建的进程和运行目录，不连接真实模型提供商或现有桌面服务。

## 配套

网关侧解析与注入规范见 [docs/gateway-contract.md](docs/gateway-contract.md)。
