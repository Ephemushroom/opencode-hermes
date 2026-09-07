# opencode-hermes(中文说明)

opencode 插件:复刻 Claude Code 的动态上下文注入机制,但不直接改 system prompt,
而是把同样的事实以 `x-hermes-*` 请求头上报,由 Hermes 网关解析后注入请求体。

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
    "scratchpadDirName": "claude",
    "gitTimeoutMs": 5000,
    "modelFilter": "claude",
    "extraEnvironment": { "team": "platform" }
  }]]
}
```

**改完配置需重启 opencode 生效**(配置不热加载)。

### OpenCode 2 beta

从 v0.2.0 起，OpenCode 1 和 2 使用**同一个包名**。V2 使用原生 `plugins` 配置（复数）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "@ephemushroom/opencode-hermes",
    "options": { "toolSearchDelivery": "immediate" }
  }]
}
```

统一入口已在 `opencode 1.18.29` 和 `opencode2 0.0.0-beta-19192` 上验证，V2 SDK 固定为 `0.0.0-beta-18050`。不支持尚未提供对象式 `server()` 加载的旧 V1。插件注册可直接执行的 `ToolSearch`，并发送 `x-hermes-client-family: opencode2` 等版本化契约头。Hermes 把 OpenCode2 工具目录转换为 Claude Code eager/deferred ToolSearch 形态；Claude 发出 ToolSearch 后，插件查询原始 schema，并通过本机 session API 投递 `<functions>` 结果。

`toolSearchDelivery` 默认 `immediate`，映射到当前 API 的 `steer`；`deferred` 映射到 `queue`。也可以直接填写 `steer` 或 `queue`。

根入口、`main` 和 `/server` 导出指向同一普通对象 `{ id, server, setup }`：V1 调用 `server`，V2 调用 `setup`，导入时不会启动任何适配器。[Effect 是可选形式](https://opencode.ai/v2/docs/build/plugins/)，本插件使用官方支持的 Promise API，无需重写为 Effect。

`/v2` 导出保留供代码直接导入；不要在当前 beta 的 `plugins` 配置中填写 npm `/v2` 后缀，它会被误判为本地路径。将旧配置项替换为裸包名，不要同时添加两项。原先直接调用默认函数的代码应改用具名 `HermesPlugin` 或 `default.server`。

升级后先结束正在运行的任务，再重启 `opencode`；V2 还需执行 `opencode2 service restart` 后重新打开客户端。两个 SDK 仅用于类型声明，运行时代码不导入 SDK 或 Effect；Zod 是运行时依赖。

### 模型过滤

默认**仅当模型 ID 包含 `claude`(大小写不敏感)时才上报 header** —
kimi/gpt 等其他模型的请求一个头也不发,原样穿过网关。Bedrock/OpenRouter 风格
的 `anthropic.claude-*` / `anthropic/claude-*` 同样命中。选项 `modelFilter`
可改匹配子串,置 `""` 则不过滤、对所有模型上报。过滤按请求判定:同一会话
切换模型时,只有 Claude 模型的请求携带头部。

## 环境变量

| 变量 | 作用 |
|---|---|
| `HERMES_CONTEXT_DISABLE=1` | 整体停用,一个 header 也不发 |
| `CLAUDE_CODE_TMPDIR` | scratchpad 临时根目录(对齐 Claude Code 语义) |

## 目录结构

```
src/index.ts   插件入口: chat.headers 钩子 + 会话级缓存 + 选项
src/v2.ts      V2 适配器: 请求头 + ToolSearch 注册与投递
src/v2-lib.ts  V2 工具目录、别名和检索逻辑
src/lib.ts     纯逻辑: x0 打平 / scratchpad 路径 / git 快照 / ASCII JSON
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

## 配套

网关侧解析与注入规范见 [docs/gateway-contract.md](docs/gateway-contract.md)。
