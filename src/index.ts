/**
 * opencode-hermes-context — opencode 插件入口。
 *
 * 在每次 LLM 请求的 chat.headers 钩子里注入 x-hermes-* 请求头:
 *
 *   x-hermes-context-version    契约版本, 当前 "1"
 *   x-hermes-environment        ASCII 安全 JSON: cwd/platform/shell/osVersion/model/agent/...
 *   x-hermes-scratchpad         ASCII 安全 JSON: { path, sessionID }(目录已落盘创建)
 *   x-hermes-context-management "true"(该块为静态常量, 网关持有 canonical 文本)
 *   x-hermes-git-status         ASCII 安全 JSON: 启动快照(会话级缓存, 非 git 仓库整头省略)
 *
 * 网关(Hermes)解析这些头, 还原出 Claude Code 风格的 system 上下文后注入请求体,
 * 转发前必须剥离全部 x-hermes-* 头。
 *
 * 配置(opencode.json):
 *   "plugin": ["file:///D:/Programme/AI/opencode-hermes/src/index.ts"]
 * 带选项:
 *   "plugin": [["file:///D:/Programme/AI/opencode-hermes/src/index.ts", {
 *     "gitStatus": true, "scratchpadDirName": "claude"
 *   }]]
 *
 * 环境变量:
 *   HERMES_CONTEXT_DISABLE=1  整体停用
 *   CLAUDE_CODE_TMPDIR        scratchpad 临时根目录(对齐 Claude Code)
 */

import type { Plugin } from "@opencode-ai/plugin"

import {
  CONTRACT_VERSION,
  HEADER_CONTEXT_MANAGEMENT,
  HEADER_ENVIRONMENT,
  HEADER_GIT_STATUS,
  HEADER_SCRATCHPAD,
  HEADER_VERSION,
  buildEnvironment,
  ensureScratchpadDir,
  gitSnapshot,
  isGitRepo,
  toHeaderJson,
  type GitSnapshot,
} from "./lib.js"

export type HermesContextOptions = {
  /** 注入 x-hermes-environment, 默认 true */
  environment?: boolean
  /** 注入 x-hermes-scratchpad 并落盘建目录, 默认 true */
  scratchpad?: boolean
  /** 注入 x-hermes-context-management, 默认 true */
  contextManagement?: boolean
  /** 注入 x-hermes-git-status, 默认 true */
  gitStatus?: boolean
  /** scratchpad 基目录名, 默认 "claude"(对齐 Claude Code 布局) */
  scratchpadDirName?: string
  /** 附加进 environment JSON 的自定义键值 */
  extraEnvironment?: Record<string, string>
  /** 单条 git 命令超时毫秒, 默认 5000 */
  gitTimeoutMs?: number
  /**
   * 仅当模型 ID 包含该子串(大小写不敏感)时才上报 header, 默认 "claude"。
   * 置空字符串则不过滤, 对所有模型上报。
   */
  modelFilter?: string
}

function disabled(): boolean {
  const v = process.env.HERMES_CONTEXT_DISABLE
  return v === "1" || v === "true"
}

const HermesContextPlugin: Plugin = async ({ directory, client }, options) => {
  const opts = (options ?? {}) as HermesContextOptions
  const useEnvironment = opts.environment !== false
  const useScratchpad = opts.scratchpad !== false
  const useContextManagement = opts.contextManagement !== false
  const useGitStatus = opts.gitStatus !== false
  const dirName = opts.scratchpadDirName ?? "claude"
  const gitTimeoutMs = opts.gitTimeoutMs ?? 5000
  const modelFilter = (opts.modelFilter ?? "claude").toLowerCase()

  // 会话级缓存: 对齐 Claude Code "snapshot in time" 语义 — 一个会话只取一次
  const gitCache = new Map<string, GitSnapshot | null>()
  const scratchpadCache = new Map<string, string | null>()
  const gitRepoCache = { value: null as boolean | null }

  try {
    await client.app.log({
      body: { service: "hermes-context", level: "info", message: `plugin loaded, cwd=${directory}` },
    })
  } catch {
    /* 日志失败不影响功能 */
  }

  return {
    "chat.headers": async (input, output) => {
      if (disabled()) return

      // 模型过滤: 默认仅 Claude 模型上报, 其余模型(如 kimi/gpt)原样放行
      const model = input.model as { id?: string; name?: string; providerID?: string }
      if (modelFilter !== "" && !(model.id ?? "").toLowerCase().includes(modelFilter)) return

      const headers = output.headers
      headers[HEADER_VERSION] = CONTRACT_VERSION

      // -- git 快照(会话级缓存; 非 git 仓库缓存 null 且整头省略) -----------
      let snapshot: GitSnapshot | null = null
      if (useGitStatus || useEnvironment) {
        if (gitCache.has(input.sessionID)) {
          snapshot = gitCache.get(input.sessionID) ?? null
        } else {
          snapshot = await gitSnapshot(directory, gitTimeoutMs)
          gitCache.set(input.sessionID, snapshot)
        }
      }

      // -- environment ------------------------------------------------------
      if (useEnvironment) {
        if (gitRepoCache.value === null) {
          gitRepoCache.value = snapshot !== null || (await isGitRepo(directory, gitTimeoutMs))
        }
        const env = buildEnvironment({
          sessionID: input.sessionID,
          agent: input.agent,
          cwd: directory,
          isGitRepo: gitRepoCache.value,
          providerID: model.providerID,
          modelID: model.id,
          modelName: model.name,
          ...(opts.extraEnvironment ? { extra: opts.extraEnvironment } : {}),
        })
        headers[HEADER_ENVIRONMENT] = toHeaderJson(env)
      }

      // -- scratchpad(惰性建目录, 每会话一次) ------------------------------
      if (useScratchpad) {
        let dir: string | null
        if (scratchpadCache.has(input.sessionID)) {
          dir = scratchpadCache.get(input.sessionID) ?? null
        } else {
          dir = ensureScratchpadDir(directory, input.sessionID, dirName)
          scratchpadCache.set(input.sessionID, dir)
        }
        if (dir !== null) {
          headers[HEADER_SCRATCHPAD] = toHeaderJson({ path: dir, sessionID: input.sessionID })
        }
      }

      // -- context management(静态常量, 只发开关) ---------------------------
      if (useContextManagement) {
        headers[HEADER_CONTEXT_MANAGEMENT] = "true"
      }

      // -- git status --------------------------------------------------------
      if (useGitStatus && snapshot !== null) {
        headers[HEADER_GIT_STATUS] = toHeaderJson(snapshot)
      }
    },
  }
}

export default HermesContextPlugin
export const HermesPlugin = HermesContextPlugin
