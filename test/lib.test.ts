import assert from "node:assert/strict"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import {
  FLATTEN_CAP,
  detectShell,
  flattenCwd,
  gitSnapshot,
  isGitRepo,
  scratchpadPathFor,
  toHeaderJson,
} from "../src/lib.js"

test("flattenCwd: 复刻 x0() 打平规则", () => {
  assert.equal(flattenCwd("D:\\Programme\\AI\\cc"), "D--Programme-AI-cc")
  // 下划线也不是字母数字, 同样被替换(对齐 Claude Code 正则 [^a-zA-Z0-9])
  assert.equal(flattenCwd("/home/user/proj_1"), "-home-user-proj-1")
})

test("flattenCwd: 超 200 字符截断并追加 hash", () => {
  const long = "a".repeat(150) + "\\" + "b".repeat(150)
  const flat = flattenCwd(long)
  assert.equal(flat.length, FLATTEN_CAP + 1 + 8)
  // 打平后 = 150a + "-" + 150b 共 301 字符, slice(0,200) 保留 150a + "-" + 49b
  assert.match(flat, /^a{150}-b{49}-[0-9a-f]{8}$/)
})

test("toHeaderJson: 非 ASCII 转义且可无损还原", () => {
  const value = { status: "?? 中文文件名.txt", branch: "master" }
  const encoded = toHeaderJson(value)
  assert.match(encoded, /^[\x00-\x7F]*$/, "header 值必须是纯 ASCII")
  assert.deepEqual(JSON.parse(encoded), value)
})

test("scratchpadPathFor: 路径五段结构与 Claude Code 一致", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-test-"))
  const prev = process.env.CLAUDE_CODE_TMPDIR
  process.env.CLAUDE_CODE_TMPDIR = tmp
  try {
    const p = scratchpadPathFor("D:\\Programme\\AI\\cc", "sess-123")
    assert.ok(p !== null)
    const rel = path.relative(fs.realpathSync.native(tmp), p!)
    assert.equal(rel, path.join("claude", "D--Programme-AI-cc", "sess-123", "scratchpad"))
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_TMPDIR
    else process.env.CLAUDE_CODE_TMPDIR = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("detectShell: 对齐 Claude Code v6s() 语义", () => {
  const prev = process.env.SHELL
  try {
    process.env.SHELL = "C:\\Program Files\\Git\\usr\\bin\\bash.exe"
    assert.equal(detectShell(), "bash")
    process.env.SHELL = "/bin/zsh"
    assert.equal(detectShell(), "zsh")
    // 无 $SHELL: Windows 固定 PowerShell(不看 ComSpec), 其余平台 unknown
    delete process.env.SHELL
    assert.equal(detectShell(), process.platform === "win32" ? "PowerShell" : "unknown")
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
  }
})

test("gitSnapshot: 真实 git 仓库产出快照", async () => {
  // 用仓库自身做样本: 本地与 CI checkout 后都是 git 仓库
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const snapshot = await gitSnapshot(repoRoot)
  assert.ok(snapshot !== null, "仓库根目录是 git 仓库, 应产出快照")
  assert.ok(snapshot!.branch.length > 0)
  assert.ok(snapshot!.mainBranch.length > 0)
  assert.equal(typeof snapshot!.status, "string")
  assert.equal(typeof snapshot!.statusTruncated, "boolean")
  assert.equal(typeof snapshot!.recentCommits, "string")
})

test("gitSnapshot: 非 git 目录返回 null", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-nogit-"))
  try {
    assert.equal(await isGitRepo(tmp), false)
    assert.equal(await gitSnapshot(tmp), null)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
