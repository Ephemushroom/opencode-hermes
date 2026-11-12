import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import {
  FLATTEN_CAP,
  detectShell,
  defaultScratchpadDirName,
  ensureScratchpadDir,
  flattenCwd,
  gitSnapshot,
  isGitRepo,
  scratchpadPathFor,
  scratchpadProjectSegment,
  tmpRoot,
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

test("scratchpad defaults follow platform and environment precedence", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    assert.equal(tmpRoot(platform, "system-temp", ""), platform === "darwin" ? "/tmp" : "system-temp")
    assert.equal(tmpRoot(platform, "system-temp", "custom-temp"), "custom-temp")
    assert.equal(defaultScratchpadDirName(platform, 501), platform === "win32" ? "claude" : "claude-501")
  }
})

test("scratchpad project segment retains Unicode and hashes normalized absolute paths", () => {
  const cwd = "/home/user/笔记Note"
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8)
  assert.equal(scratchpadProjectSegment(cwd, "linux"), `笔记Note-${hash}`)
  assert.equal(scratchpadProjectSegment("/home/user/other/../笔记Note/", "linux"), `笔记Note-${hash}`)
  assert.notEqual(scratchpadProjectSegment("/other/笔记Note", "linux"), `笔记Note-${hash}`)
  assert.equal(scratchpadProjectSegment("笔记Note"), scratchpadProjectSegment(path.resolve("笔记Note")))
  assert.match(scratchpadProjectSegment("C:\\work\\笔记Note\\", "win32"), /^笔记Note-[0-9a-f]{8}$/)
  assert.match(scratchpadProjectSegment("/", "linux"), /^root-[0-9a-f]{8}$/)
  assert.match(scratchpadProjectSegment("C:\\", "win32"), /^root-[0-9a-f]{8}$/)
})

test("scratchpad project segment sanitizes names and bounds Unicode bytes without splitting code points", () => {
  assert.match(scratchpadProjectSegment('/work/a<>:"\\|?*\x01. ', "linux"), /^a-{9}-[0-9a-f]{8}$/)
  const segment = scratchpadProjectSegment(`/work/${"笔记😀".repeat(100)}`, "linux")
  assert.ok(Buffer.byteLength(segment, "utf8") <= 209)
  assert.equal(segment.includes("\ufffd"), false)
  assert.equal(Buffer.from(segment).toString("utf8"), segment)
  assert.match(segment, /-[0-9a-f]{8}$/)
})

test("scratchpadPathFor: readable layout, full session ID, exact override and actual creation", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-test-"))
  const prev = process.env.CLAUDE_CODE_TMPDIR
  process.env.CLAUDE_CODE_TMPDIR = tmp
  try {
    const cwd = path.join(tmp, "笔记Note")
    const sessionID = "ses_1234567890_full_session_id"
    const p = scratchpadPathFor(cwd, sessionID)
    assert.ok(p !== null)
    const rel = path.relative(fs.realpathSync.native(tmp), p!)
    assert.equal(rel, path.join(defaultScratchpadDirName(), scratchpadProjectSegment(cwd), sessionID, "scratchpad"))
    assert.equal(fs.existsSync(p), false)
    assert.equal(ensureScratchpadDir(cwd, sessionID), p)
    assert.equal(fs.statSync(p).isDirectory(), true)
    if (process.platform !== "win32") assert.equal(fs.statSync(p).mode & 0o777, 0o700)
    const header = toHeaderJson({ path: p })
    assert.ok(Array.from(header).every((character) => character.charCodeAt(0) <= 127))
    assert.deepEqual(JSON.parse(header), { path: p })
    const custom = scratchpadPathFor(cwd, sessionID, "custom-name")
    assert.equal(custom, path.join(fs.realpathSync.native(tmp), "custom-name", scratchpadProjectSegment(cwd), sessionID, "scratchpad"))
    assert.equal(scratchpadPathFor(cwd, sessionID, "claude"), path.join(fs.realpathSync.native(tmp), "claude", scratchpadProjectSegment(cwd), sessionID, "scratchpad"))
    const long = ensureScratchpadDir(path.join(tmp, "笔记😀".repeat(100)), sessionID)
    assert.ok(long !== null && fs.statSync(long).isDirectory())
    const blocked = path.join(tmp, "blocked")
    fs.writeFileSync(blocked, "not a directory")
    assert.equal(ensureScratchpadDir(cwd, sessionID, "blocked"), null)
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
