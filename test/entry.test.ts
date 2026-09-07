import assert from "node:assert/strict"
import { test } from "node:test"

import * as entry from "../src/index.js"
import v2 from "../src/v2.js"
import manifest from "../package.json" with { type: "json" }

test("the root entry exposes native V2 setup while retaining the V1 callable", () => {
  // Given the same module imported by either OpenCode generation.
  const plugin: unknown = entry.default

  // When V2 inspects its default export.
  assert.ok(plugin !== null && typeof plugin === "object")
  assert.ok("id" in plugin && typeof plugin.id === "string")
  assert.ok("setup" in plugin && typeof plugin.setup === "function")

  // Then V1 can use the server entry without loading it twice.
  assert.ok("server" in plugin)
  assert.equal(plugin.server, entry.HermesPlugin)
  assert.equal(plugin.setup, v2.setup)
  assert.equal(plugin.id, v2.id)
  assert.equal("tui" in plugin, false)
})

test("both host resolvers select the unified package entry", () => {
  // Given the package manifest used by native host resolution.
  const root = manifest.exports["."]

  // When the host prefers /server or falls back to main.
  const server = manifest.exports["./server"]

  // Then runtime and declaration entrypoints agree, while /v2 stays explicit.
  assert.deepEqual(server, root)
  assert.equal(manifest.main, root.import)
  assert.equal(manifest.types, root.types)
  assert.equal(manifest.exports["./v2"].import, "./dist/v2.js")
})
