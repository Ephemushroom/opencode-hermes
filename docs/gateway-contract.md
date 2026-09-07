# Hermes 网关处理文档 — x-hermes-* 上下文头

> 契约版本: **1**(`x-hermes-context-version: 1`)
> 上游来源: `opencode-hermes` 插件(`chat.headers` 钩子,每次 LLM 请求都携带)
> 目标: 解析头部事实,还原 Claude Code 风格的四块上下文,注入请求体后转发上游。

---

## 0. 数据流

```
opencode ──HTTP──▶ Hermes ──HTTP──▶ 上游 LLM
             x-hermes-*        注入后的 body,无 x-hermes-*
```

网关职责三步:

1. **读取并解析** `x-hermes-*` 头(header 名大小写不敏感);
2. **注入**:按下文模板拼出文本块,写进请求体的 system 上下文;
3. **剥离**:转发上游前删除全部 `x-hermes-*` 头 — 它们是内部契约,
   不应泄露给上游提供商(路径里含本地用户名与项目路径)。

任何头缺失 = 对应块不注入(例如非 opencode 客户端直连,原样透传即可)。

**注意**:插件默认仅在模型 ID 含 `claude`(大小写不敏感)时上报 — 网关在
kimi/gpt 等模型的请求上看不到这些头,属正常行为而非故障(插件侧
`modelFilter` 选项可改)。

---

## 1. Header 契约

### 1.1 `x-hermes-context-version` — 契约版本

固定 `"1"`。破坏性变更时插件侧递增。网关对未知版本建议:记 warning 日志,
仍按 v1 规则解析(向后兼容字段只增不减)。

### 1.2 `x-hermes-environment` — 环境事实(JSON)

字段与 Claude Code `# Environment` 块渲染项一一对应,外加 `agent`(§5 subagent 策略用)。
模型 ID/显示名**不上报** — 网关从请求体的 `model` 字段自取。

```json
{
  "agent": "build",
  "cwd": "D:\\Programme\\AI\\Hermes",
  "isGitRepo": true,
  "platform": "win32",
  "shell": "PowerShell",
  "osVersion": "Windows_NT 10.0.26100"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `agent` | string | 发起请求的 agent 名;**非主 agent 时是 subagent**,见 §5 |
| `cwd` | string | opencode 启动目录(originalCwd) |
| `isGitRepo` | bool | 启动目录是否 git 仓库 |
| `platform` | string | Node `process.platform`:`win32` / `darwin` / `linux` |
| `shell` | string | 对齐 Claude Code `v6s()`:`$SHELL` 存在时取原值(zsh/bash 简化为裸名);Windows 上无 `$SHELL` 时固定 `"PowerShell"`(**不看 ComSpec** — 那是系统命令解释器,非用户终端);非 Windows 且无 `$SHELL` 为 `"unknown"` |
| `osVersion` | string | `os.type() + " " + os.release()` |

插件选项 `extraEnvironment` 可追加自定义键(例如需要会话关联时自行加回
`sessionID`),解析时应容忍未知字段。

### 1.3 `x-hermes-scratchpad` — scratchpad 目录(JSON)

```json
{ "path": "C:\\Users\\Bryan\\AppData\\Local\\Temp\\claude\\D--Programme-AI-Hermes\\4f101af4-...\\scratchpad" }
```

- `path` 是**已落盘创建**(0o700)的绝对路径,结构
  `<tmpdir>/claude/<x0(cwd)>/<sessionID>/scratchpad`,与 Claude Code 逐字对齐;
  sessionID 已含在路径中,不单独携带;
- 客户端创建失败时该头**整体缺失**,网关按不注入处理;
- 路径含本地用户名与项目路径 — 注入给模型是设计意图(对齐 Claude Code),
  但必须随头一起剥离,不得出现在转发上游的原始 header 中。

### 1.4 `x-hermes-context-management` — 静态开关

值固定 `"true"`。该块在 Claude Code 中是零运行期成分的静态常量(`HO_`),
文本由网关持有(见 §4.3),头部只表示"该客户端会话需要此块"。

### 1.5 `x-hermes-git-status` — git 启动快照(JSON)

**非 git 仓库或探测失败时整头省略**,不是空值。

```json
{
  "branch": "main",
  "mainBranch": "main",
  "user": "Bryan",
  "status": "M apps/server/Program.cs\n?? docs/new.md",
  "statusTruncated": false,
  "recentCommits": "590fb06 Renew the access token...\n4536f09 Keep quota snapshots..."
}
```

| 字段 | 说明 |
|---|---|
| `branch` | 当前分支;detached/异常时为字面量 `"HEAD"` |
| `mainBranch` | PR 用主分支;解析链 `origin/HEAD` → `origin/main` → `origin/master` → `"main"` |
| `user` | `git config user.name`;**为空时字段不存在**,拼装时整行省略 |
| `status` | `git status --short`;空输出时为 `"(clean)"`;触及上限则截断 |
| `statusTruncated` | `status` 是否已被截断(阈值 2000 字符),截断提示由网关拼装(§4.4) |
| `recentCommits` | `git log --oneline -n 5`;无 commit 的空仓库为 `""`,**字段保留** |

**会话级快照**:插件每个 sessionID 只取一次 git,后续请求重复发送同一份。
网关无需也不应尝试"刷新"它 — 这与 Claude Code 文案
"snapshot in time, will not update during the conversation" 一致。

---

## 2. 编码规则

所有 JSON 头值均为 **ASCII 安全 JSON**:非 ASCII 字符已转义为 `\uXXXX`
(中文路径、中文文件名等)。`System.Text.Json` 的 `JsonDocument.Parse` /
`JsonSerializer.Deserialize` **原生还原**,无需额外解码步骤。

```
原始值:  ?? 新增文件.txt
头中值:  \"?? \\u65B0\\u589E\\u6587\\u4EF6.txt\"      ← 纯 ASCII
解析后:  "?? 新增文件.txt"                            ← 自动还原
```

注意: `status` / `recentCommits` 内的换行在 JSON 中是 `\n` 转义,解析后即为真实多行文本。

---

## 3. 解析示例(C# / Hermes 网关)

```csharp
using System.Text.Json;

public sealed record HermesContext(
    JsonDocument? Environment,
    string? ScratchpadPath,
    bool ContextManagement,
    GitStatus? Git);

public sealed record GitStatus(
    string Branch, string MainBranch, string? User,
    string Status, bool StatusTruncated, string RecentCommits);

public static class HermesContextHeaders
{
    public static readonly string[] All =
    [
        "x-hermes-context-version",
        "x-hermes-environment",
        "x-hermes-scratchpad",
        "x-hermes-context-management",
        "x-hermes-git-status",
    ];

    public static HermesContext Parse(HttpRequest req)
    {
        var env = ParseJson(req, "x-hermes-environment");

        string? scratchpad = null;
        using var sp = ParseJson(req, "x-hermes-scratchpad");
        if (sp is not null && sp.RootElement.TryGetProperty("path", out var p))
            scratchpad = p.GetString();

        var ctxMgmt = req.Headers["x-hermes-context-management"].FirstOrDefault() == "true";

        GitStatus? git = null;
        using var gs = ParseJson(req, "x-hermes-git-status");
        if (gs is not null)
        {
            var r = gs.RootElement;
            git = new GitStatus(
                Branch: r.GetProperty("branch").GetString()!,
                MainBranch: r.GetProperty("mainBranch").GetString()!,
                User: r.TryGetProperty("user", out var u) ? u.GetString() : null,
                Status: r.GetProperty("status").GetString()!,
                StatusTruncated: r.GetProperty("statusTruncated").GetBoolean(),
                RecentCommits: r.GetProperty("recentCommits").GetString()!);
        }
        return new HermesContext(env, scratchpad, ctxMgmt, git);
    }

    private static JsonDocument? ParseJson(HttpRequest req, string name)
    {
        var raw = req.Headers[name].FirstOrDefault();
        if (string.IsNullOrEmpty(raw)) return null;
        try { return JsonDocument.Parse(raw); }
        catch (JsonException) { return null; }   // 坏头不致命,按缺失处理
    }

    /// <summary>转发上游前必须调用</summary>
    public static void Strip(HttpRequestMessage outgoing)
    {
        foreach (var h in All) outgoing.Headers.Remove(h);
    }
}
```

YARP 场景:在 transform / egress 管道里先 `Parse`,注入 body 后 `Strip`。
注意 YARP 默认**原样转发所有请求头**,不主动删就会泄露到上游。

---

## 4. 注入算法(还原 Claude Code 四块文本)

模板依据 `D:\Programme\AI\cc\docs\CONTEXT-INJECTION.md` 与抓包实证,
字段全部来自头部 JSON,措辞与 Claude Code 原文逐字对齐。

### 4.1 `# Environment` 块(来自 1.2)

```
# Environment
You have been invoked in the following environment:
 - Primary working directory: {cwd}
 - Is a git repository: {isGitRepo:true|false}
 - Platform: {platform}
 - Shell: {shell}
 - OS Version: {osVersion}
 - You are powered by the model named {modelName}. The exact model ID is {modelID}.
```

模型行由网关从请求体 `model` 字段渲染(`modelName` 无显示名时可只写 ID 或按
Claude Code 文案退化);`shell` 不会为 null(v6s 语义,见 §1.2)。

### 4.2 `# Scratchpad Directory` 块(来自 1.3)

```
# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of `/tmp` or other system temp directories:
`{path}`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to `/tmp`

Only use `/tmp` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can generally be used without permission prompts.
```

### 4.3 `# Context management` 块(来自 1.4,网关持有的常量)

```
# Context management
When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.
```

### 4.4 `gitStatus` 块(来自 1.5)

按序拼装,`\n\n` 分段:

```
This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

Current branch: {branch}

Main branch (you will usually use this for PRs): {mainBranch}

Git user: {user}                    ← user 为 null 时整段省略

Status:
{status}

Recent commits:
{recentCommits}
```

`statusTruncated == true` 时在 Status 内容后追加(对齐 Claude Code 原文,
其中 shell 工具名可取当前可用 shell 工具名):

```
... (truncated because it exceeds 2k characters. If you need more information, run "git status" using {shellToolName})
```

### 4.5 落点与顺序(对齐 Claude Code 组装行为)

- Anthropic 形态:四块各自成为 `system[]` 数组元素。
  顺序建议:`# Environment` → `# Scratchpad Directory` → `# Context management`
  保持在前;**gitStatus 块固定放 system 数组末尾**,且带键名前缀 —
  Claude Code 的 `Hud()` 把 systemContext 序列化为 `${key}: ${value}` 追加到末尾,
  即该块第一个字符是 `gitStatus: ` 紧跟上文模板:

  ```
  gitStatus: This is the git status at the start of the conversation. ...
  ```

- OpenAI 形态:同一文本并入 `messages[0]`(role=system)末尾即可。

**Prompt cache 边界**:git 快照是四块中唯一随仓库状态变化的内容,
放在末尾独立块可最大化前缀缓存命中;不要把它揉进 environment 块中间。

### 4.6 组装示例(C#)

```csharp
public static class HermesContextInjector
{
    /// <summary>按 §4 模板把解析结果还原为 system 文本块, 返回顺序即注入顺序。</summary>
    public static IReadOnlyList<string> BuildBlocks(HermesContext ctx, string modelFromBody)
    {
        var blocks = new List<string>();

        if (ctx.Environment is { } envDoc)                       // §4.1
        {
            var e = envDoc.RootElement;
            blocks.Add($"""
                # Environment
                You have been invoked in the following environment:
                 - Primary working directory: {e.GetProperty("cwd").GetString()}
                 - Is a git repository: {e.GetProperty("isGitRepo").GetBoolean()}
                 - Platform: {e.GetProperty("platform").GetString()}
                 - Shell: {e.GetProperty("shell").GetString()}
                 - OS Version: {e.GetProperty("osVersion").GetString()}
                 - You are powered by the model named {modelFromBody}. The exact model ID is {modelFromBody}.
                """);
        }

        if (ctx.ScratchpadPath is { } sp)                        // §4.2
            blocks.Add(ScratchpadBlock.Replace("{path}", sp));

        if (ctx.ContextManagement)                               // §4.3
            blocks.Add(ContextManagementBlock);

        if (ctx.Git is { } g)                                    // §4.4, 固定末尾, 带 "gitStatus: " 前缀
        {
            var sb = new StringBuilder();
            sb.Append("This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.");
            sb.Append("\n\nCurrent branch: ").Append(g.Branch);
            sb.Append("\n\nMain branch (you will usually use this for PRs): ").Append(g.MainBranch);
            if (g.User is not null) sb.Append("\n\nGit user: ").Append(g.User);
            sb.Append("\n\nStatus:\n").Append(g.Status);
            if (g.StatusTruncated)
                sb.Append("\n... (truncated because it exceeds 2k characters. If you need more information, run \"git status\" using the available shell tool)");
            sb.Append("\n\nRecent commits:\n").Append(g.RecentCommits);
            blocks.Add("gitStatus: " + sb);
        }
        return blocks;
    }

    // Anthropic 形态: 逐块 append 进请求体 "system" 数组;
    // OpenAI 形态: string.Join("\n\n", blocks) 并入 messages[0] (role=system) 末尾。
}
```

注入后调用 `HermesContextHeaders.Strip`(§3)再转发。

---

## 5. Subagent 策略(可选,对齐 Claude Code §5.7)

Claude Code 构造 subagent 上下文时**显式剔除 gitStatus**(`let { gitStatus, ...rest }`)。
若要对齐:`environment.agent` 不是主 agent(opencode 默认主 agent 为 `build`)时,
注入阶段跳过 gitStatus 块,其余三块保留。是否启用由 Hermes 配置决定。

---

## 6. 安全清单

- [ ] 转发上游前剥离全部 `x-hermes-*` 头(YARP 默认透传,必须主动删);
- [ ] `gitStatus` 含分支名、`user.name`、最多 2000 字符的工作区文件列表 —
      注入 body 是设计行为,但若 Hermes 有对外/第三方转发路径,这是首要脱敏字段;
- [ ] scratchpad `path` 含本地用户名(`C:\Users\Bryan\...`)与项目路径,同理;
- [ ] 解析失败(坏 JSON、缺字段)一律降级为"该块不注入",不要 500;
- [ ] 头部体积:单头最坏 ~2.2 KB(status 截断兜底),远低于常见 8 KB 上限;
      网关若有更严的 header 限制,需在接入层放行 `x-hermes-*`。

---

## 7. 建议落点

`apps/egress`:在请求改写(账号/模型路由之后、上游转发之前)插入
`HermesContextMiddleware`:`Parse` → 按 §4 模板注入 body → `Strip`。
测试可参照 `apps/server.tests/Proxy/WatchdogYarpIntegrationTests.cs` 的
header 断言模式,对全部 `x-hermes-*` 头做往返验证。

---

## 8. OpenCode2 ToolSearch 契约

OpenCode2 与 V1 共用插件包名 `@ephemushroom/opencode-hermes`（V2 使用 `plugins` 配置），V2 适配器额外发送：

| Header | 值 | 说明 |
|---|---|---|
| `x-hermes-client-family` | `opencode2` | 在相同的 `opencode/<version>` UA 下区分 V2 |
| `x-hermes-tool-protocol-version` | `1` | ToolSearch 双向转换契约版本 |
| `x-hermes-tool-delivery` | `steer` / `queue` | OpenCode2 session inbox 的结果投递方式 |

Hermes 仅在 UA 属于 OpenCode、版本头合法且 `tools[]` 存在插件注册的 `ToolSearch` 时判定为 OpenCode2。三个内部头与上下文头一样，转发上游前必须全部剥离。

往返流程：

1. 插件缓存 `session.context` 的原始工具 schema，并注册直接工具 `ToolSearch`；`session.model.request` 注入契约头。
2. Hermes 的 OpenCode2 handler 把 V2 内建名 `shell/subagent` 临时适配为 legacy `bash/task`，复用既有 Claude Code `Bash/Agent` eager 指纹，响应时再恢复 V2 原名。
3. 入站插件 ToolSearch 定义由 Hermes 替换为 canonical Claude Code 定义；Claude 返回同名 tool_use 后由插件直接执行。
4. 插件按确定性别名规则查询 deferred schema、渲染 `<functions>`，再调用本机 `session.prompt`。旧称 `immediate/deferred` 分别映射到当前 API 的 `steer/queue`。

Hermes 不接受客户端提供的任意 OpenCode2 回调 URL；本机会话投递由进程内插件完成，从结构上避免 SSRF、远程服务发现和额外认证面。
