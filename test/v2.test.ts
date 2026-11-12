import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import plugin from "../src/v2.js";
import { defaultScratchpadDirName, scratchpadProjectSegment } from "../src/lib.js";

type Request = {
  sessionID: string;
  agent: string;
  model: { id: string };
  headers: Record<string, string>;
};

async function setup(options: Record<string, unknown> = {}, directory = process.cwd()) {
  const hooks = new Map<string, (event: Request) => Promise<void>>();
  const context = {
    options: { environment: false, scratchpad: false, gitStatus: false, ...options },
    session: {
      hook: async (name: string, callback: (event: Request) => Promise<void>) => {
        hooks.set(name, callback);
      },
      get: async () => ({ location: { directory } }),
    },
    // Accessing tool registration or session.prompt is deliberately unsupported:
    // the context reporter must not own discovery or result delivery.
  };
  await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);
  return hooks;
}

test("V2 only reports context and leaves native Code Mode identity intact", async () => {
  const hooks = await setup();
  assert.deepEqual([...hooks.keys()], ["model.request"]);
  const native = {
    "User-Agent": "opencode/stable/2.0.6/cli",
    "x-opencode-project": "project",
    "x-opencode-session": "ses_native",
    "x-opencode-client": "cli",
  };
  const event: Request = { sessionID: "ses_native", agent: "build",
    model: { id: "claude-sonnet-4-6" }, headers: { ...native } };
  await hooks.get("model.request")!(event);
  assert.deepEqual(event.headers, {
    ...native, "x-hermes-context-version": "1", "x-hermes-context-management": "true",
  });
});

test("old delivery options cannot re-enable companion ToolSearch", async () => {
  const hooks = await setup({ toolSearchDelivery: "queue" });
  assert.deepEqual([...hooks.keys()], ["model.request"]);
  const event: Request = { sessionID: "ses_old", agent: "build",
    model: { id: "claude-sonnet-4-6" }, headers: {} };
  await hooks.get("model.request")!(event);
  assert.equal("x-hermes-tool-protocol-version" in event.headers, false);
  assert.equal("x-hermes-tool-delivery" in event.headers, false);
  assert.equal("x-hermes-client-family" in event.headers, false);
});

test("V2 model filter preserves non-Claude requests", async () => {
  const hooks = await setup();
  const event: Request = { sessionID: "ses_other", agent: "build",
    model: { id: "gpt-6" }, headers: { "User-Agent": "opencode/stable/2.0.6/cli" } };
  await hooks.get("model.request")!(event);
  assert.deepEqual(event.headers, { "User-Agent": "opencode/stable/2.0.6/cli" });
});

test("V2 scratchpad header reports an existing readable session directory", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-v2-"));
  const previous = process.env.CLAUDE_CODE_TMPDIR;
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  try {
    const directory = path.join(tmp, "笔记Note");
    for (const custom of [undefined, "custom-scratchpads", "claude"]) {
      const hooks = await setup({ scratchpad: true, ...(custom === undefined ? {} : { scratchpadDirName: custom }) }, directory);
      const event: Request = { sessionID: "ses_complete_1234567890", agent: "build", model: { id: "claude-sonnet-4-6" }, headers: {} };
      await hooks.get("model.request")!(event);
      const header = event.headers["x-hermes-scratchpad"]!;
      assert.ok(Array.from(header).every((character) => character.charCodeAt(0) <= 127));
      const expected = path.join(fs.realpathSync.native(tmp), custom ?? defaultScratchpadDirName(), scratchpadProjectSegment(directory), event.sessionID, "scratchpad");
      assert.deepEqual(JSON.parse(header), { path: expected });
      assert.ok(fs.statSync(expected).isDirectory());
      await hooks.get("model.request")!(event);
      assert.equal(event.headers["x-hermes-scratchpad"], header);
      const next = { ...event, sessionID: "ses_another_full_id", headers: {} };
      await hooks.get("model.request")!(next);
      assert.ok(fs.statSync(path.join(path.dirname(path.dirname(expected)), next.sessionID, "scratchpad")).isDirectory());
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
