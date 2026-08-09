/**
 * Hermes 上下文上报 — 纯逻辑层。
 *
 * 算法逐行复刻 Claude Code 2.1.214/2.1.220 的动态上下文注入机制,
 * 依据: D:\Programme\AI\cc\docs\CONTEXT-INJECTION.md
 *
 * 与 Claude Code 的差异仅在于产出形式: Claude Code 把上下文拼进 system prompt,
 * 本插件把同样的事实以 ASCII 安全 JSON 放进 x-hermes-* 请求头, 由 Hermes 网关
 * 解析后注入。
 */

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// ---------------------------------------------------------------------------
// 常量(对齐 Claude Code 实现值)
// ---------------------------------------------------------------------------

/** git status --short 输出截断阈值, Claude Code: kKi/Nds = 2000 */
export const STATUS_LIMIT = 2000

/** x0() 打平 cwd 的长度上限, Claude Code: ixt = 200 */
export const FLATTEN_CAP = 200

/**
 * 分支探测命令的安全前缀, 禁掉仓库自带 hook 与 fsmonitor,
 * 防止恶意仓库配置执行任意代码。对齐 Claude Code 的 Sl。
 */
export const GIT_SAFETY_FLAGS: readonly string[] = Object.freeze([
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=",
])

/** 单次 git 命令超时 */
export const GIT_TIMEOUT_MS = 5000

// ---------------------------------------------------------------------------
// Header 名(契约, 与 docs/gateway-contract.md 保持一致)
// ---------------------------------------------------------------------------

export const HEADER_VERSION = "x-hermes-context-version"
export const HEADER_ENVIRONMENT = "x-hermes-environment"
export const HEADER_SCRATCHPAD = "x-hermes-scratchpad"
export const HEADER_CONTEXT_MANAGEMENT = "x-hermes-context-management"
export const HEADER_GIT_STATUS = "x-hermes-git-status"

/** 契约版本, 破坏性变更时递增 */
export const CONTRACT_VERSION = "1"

// ---------------------------------------------------------------------------
// Header 值编码: ASCII 安全 JSON
// ---------------------------------------------------------------------------

/**
 * JSON.stringify 之后把所有非 ASCII 字符转义为 \\uXXXX。
 * HTTP header 值在传输层按 latin-1 处理, 直接放 UTF-8 中文会被破坏;
 * 转义后网关侧 JSON.parse / JsonSerializer 原生还原, 无需特殊处理。
 */
export function toHeaderJson(value: unknown): string {
  const json = JSON.stringify(value) ?? "null"
  return json.replace(/[^\x00-\x7F]/g, (ch) => {
    return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
  })
}

// ---------------------------------------------------------------------------
// scratchpad 路径(复刻 jY/Iw/Lie/rpe/S2_ 链条)
// ---------------------------------------------------------------------------

/**
 * x0(): 把 cwd 中所有非字母数字字符打平为 '-'。
 * 超过 200 字符时截断并追加内容 hash, 避免深层路径撞名。
 */
export function flattenCwd(cwd: string): string {
  const flat = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  if (flat.length <= FLATTEN_CAP) return flat
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8)
  return `${flat.slice(0, FLATTEN_CAP)}-${hash}`
}

/** jY(): 临时目录根, CLAUDE_CODE_TMPDIR 优先 */
export function tmpRoot(): string {
  return process.env.CLAUDE_CODE_TMPDIR || os.tmpdir()
}

/**
 * Iw() + Lie(): <tmpRoot>/<dirName>, 立即创建(0o700)并取 realpath。
 * 失败返回 null — 对齐 Claude Code 的 getScratchpadDir() 可返回 null 的语义。
 */
export function scratchpadBaseDir(dirName = "claude"): string | null {
  const base = path.join(tmpRoot(), dirName)
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
    return fs.realpathSync.native(base)
  } catch {
    return null
  }
}

/**
 * rpe() + S2_(): <base>/<x0(cwd)>/<sessionID>/scratchpad
 * 纯计算, 不落盘。
 */
export function scratchpadPathFor(cwd: string, sessionID: string, dirName = "claude"): string | null {
  const base = scratchpadBaseDir(dirName)
  if (base === null) return null
  return path.join(base, flattenCwd(cwd), sessionID, "scratchpad")
}

/**
 * ensureScratchpadDir: 计算路径并落盘创建(0o700)。
 * 每个会话首次上报时调用一次, 对应 Claude Code init 阶段的 wBo()。
 */
export function ensureScratchpadDir(cwd: string, sessionID: string, dirName = "claude"): string | null {
  const dir = scratchpadPathFor(cwd, sessionID, dirName)
  if (dir === null) return null
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// git 快照(复刻 vfo(): 五条命令并发, 会话级缓存由调用方负责)
// ---------------------------------------------------------------------------

export type GitSnapshot = {
  branch: string
  mainBranch: string
  /** git config user.name; 为空则字段不存在(对齐 Claude Code 整行省略) */
  user?: string
  /** git status --short, 空仓库输出替换为 "(clean)" */
  status: string
  /** status 是否触及 2000 字符截断 */
  statusTruncated: boolean
  /** git log --oneline -n 5; 无 commit 时为空串(字段保留) */
  recentCommits: string
}

function runGit(cwd: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout.trim())
        }
      },
    )
  })
}

/** BA(): 是否 git 仓库 */
export async function isGitRepo(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<boolean> {
  try {
    const out = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], timeoutMs)
    return out === "true"
  } catch {
    return false
  }
}

/** AT(): 当前分支, 失败回退字面量 "HEAD" */
async function currentBranch(cwd: string, timeoutMs: number): Promise<string> {
  try {
    const out = await runGit(cwd, [...GIT_SAFETY_FLAGS, "rev-parse", "--abbrev-ref", "HEAD"], timeoutMs)
    return out || "HEAD"
  } catch {
    return "HEAD"
  }
}

/**
 * wB(): 主分支。symbolic-ref refs/remotes/origin/HEAD,
 * 失败则依次探 origin/main、origin/master, 兜底 "main"。
 */
async function mainBranch(cwd: string, timeoutMs: number): Promise<string> {
  try {
    const sym = await runGit(cwd, [...GIT_SAFETY_FLAGS, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], timeoutMs)
    if (sym) return sym.replace(/^origin\//, "")
  } catch {
    /* 继续走探测链 */
  }
  try {
    await runGit(cwd, [...GIT_SAFETY_FLAGS, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], timeoutMs)
    return "main"
  } catch {
    /* 继续 */
  }
  try {
    await runGit(cwd, [...GIT_SAFETY_FLAGS, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/master"], timeoutMs)
    return "master"
  } catch {
    /* 继续 */
  }
  return "main"
}

/**
 * vfo(): 启动 git 快照。
 * 非 git 仓库或 status 命令失败 → 返回 null(整个 header 不注入)。
 * log 失败(如新仓库无 commit)→ recentCommits 为空串, 字段保留。
 * user.name 为空 → user 字段不存在。
 */
export async function gitSnapshot(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitSnapshot | null> {
  if (!(await isGitRepo(cwd, timeoutMs))) return null

  const statusP = runGit(cwd, ["--no-optional-locks", "status", "--short"], timeoutMs)
  const logP = runGit(cwd, ["--no-optional-locks", "log", "--oneline", "-n", "5"], timeoutMs).catch(() => "")
  const userP = runGit(cwd, ["config", "user.name"], timeoutMs).catch(() => "")

  let statusRaw: string
  try {
    const [branch, main, status] = await Promise.all([currentBranch(cwd, timeoutMs), mainBranch(cwd, timeoutMs), statusP])
    statusRaw = status
    const [recentCommits, user] = await Promise.all([logP, userP])

    const statusTruncated = statusRaw.length > STATUS_LIMIT
    const snapshot: GitSnapshot = {
      branch,
      mainBranch: main,
      status: statusTruncated ? statusRaw.substring(0, STATUS_LIMIT) : statusRaw || "(clean)",
      statusTruncated,
      recentCommits,
    }
    if (user) snapshot.user = user
    return snapshot
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// environment 块
// ---------------------------------------------------------------------------

export type EnvironmentFacts = {
  agent: string
  cwd: string
  isGitRepo: boolean
  platform: string
  shell: string | null
  osVersion: string
  modelID: string | null
  modelName: string | null
  [key: string]: unknown
}

export function detectShell(): string | null {
  return process.env.SHELL ?? process.env.ComSpec ?? null
}

export function buildEnvironment(input: {
  agent: string
  cwd: string
  isGitRepo: boolean
  modelID?: string | undefined
  modelName?: string | undefined
  extra?: Record<string, string> | undefined
}): EnvironmentFacts {
  return {
    agent: input.agent,
    cwd: input.cwd,
    isGitRepo: input.isGitRepo,
    platform: process.platform,
    shell: detectShell(),
    osVersion: `${os.type()} ${os.release()}`,
    modelID: input.modelID ?? null,
    modelName: input.modelName ?? null,
    ...(input.extra ?? {}),
  }
}
