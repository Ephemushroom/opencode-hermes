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
  system?: { type: "text"; text: string; metadata?: Record<string, unknown> }[];
};

const recommendation = "  Prefer /private/tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.";
const environment = `<env>\n  Working directory: /project\n  Platform: darwin\n${recommendation}\n</env>`;
function coreSystem() {
  return [{ type: "text" as const, text: environment,
    metadata: { experimental: { instructions: [{ key: "core/environment", text: environment }] } } }];
}

async function setup(options: Record<string, unknown> = {}, directory: string | ((sessionID: string) => string) = process.cwd()) {
  const hooks = new Map<string, (event: Request) => Promise<void>>();
  const context = {
    options: { environment: false, scratchpad: false, gitStatus: false, ...options },
    session: {
      hook: async (name: string, callback: (event: Request) => Promise<void>) => {
        hooks.set(name, callback);
      },
      get: async ({ sessionID }: { sessionID: string }) => ({ location: { directory: typeof directory === "string" ? directory : directory(sessionID) } }),
    },
    // Accessing tool registration or session.prompt is deliberately unsupported:
    // the context reporter must not own discovery or result delivery.
  };
  await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);
  return hooks;
}

test("V2 reports headers and leaves native Code Mode identity intact", async () => {
  const hooks = await setup();
  assert.deepEqual([...hooks.keys()], ["context", "compaction", "generate", "title", "model.request"]);
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

async function withScratchpad(run: (tmp: string) => Promise<void>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-v2-cases-"));
  const previous = process.env.CLAUDE_CODE_TMPDIR;
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  try { await run(tmp); }
  finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function request(model = "claude-sonnet-4-6", sessionID = "ses_cases"): Request & { system: NonNullable<Request["system"]> } {
  return { sessionID, agent: "build", model: { id: model }, headers: {}, system: coreSystem() };
}

test("V2 preserves history, metadata aliases and custom copies across repeated requests", async () => {
  await withScratchpad(async (tmp) => {
    const hooks = await setup({ scratchpad: true }, tmp);
    const original = coreSystem()[0]!;
    const sources = [{ key: "core/date", text: "Today's date: test" }, ...original.metadata.experimental.instructions];
    const text = sources.map((entry) => entry.text).join("\n\n");
    const metadata = Object.freeze({ experimental: Object.freeze({ instructions: Object.freeze(sources.map((source) => Object.freeze(source))) }), custom: "keep" });
    const part = Object.freeze({ type: "text" as const, text, metadata });
    const custom = { type: "text" as const, text: `Quoted example:\n${environment}` };
    const messages = Object.freeze([{ role: "user", content: environment }, { role: "assistant", content: environment }]);
    const tools = { execute: { description: "native", input: {} } };
    const event = { ...request(), system: [custom, part], messages, tools, options: { temperature: 0.5 } };
    await hooks.get("context")!(event);
    const rewritten = event.system[1]!.text;
    assert.notEqual(rewritten, text);
    assert.ok(rewritten.startsWith("Today's date: test\n\n<env>\n  Working directory: /project\n  Platform: darwin\n"));
    assert.equal(part.text, text);
    assert.equal(event.system[0], custom);
    assert.ok("metadata" in event.system[1]!);
    assert.equal(event.system[1]!.metadata, metadata);
    assert.equal(event.messages, messages);
    assert.equal(event.tools, tools);
    assert.deepEqual(event.options, { temperature: 0.5 });
    await hooks.get("context")!(event);
    assert.equal(event.system[1]!.text, rewritten);
    const switched = { ...event, model: { id: "gpt-6" }, system: [part], headers: {} };
    await hooks.get("context")!(switched);
    await hooks.get("model.request")!(switched);
    assert.equal(switched.system[0], part);
    assert.deepEqual(switched.headers, {});
  });
});

test("V2 requires intact, unique core provenance and the exact built-in template", async () => {
  const metadata = (instructions: unknown) => ({ experimental: { instructions } });
  const entry = { key: "core/environment", text: environment };
  const cases: { name: string; system: NonNullable<Request["system"]> }[] = [
    { name: "absent", system: [{ type: "text", text: environment }] },
    ...[{}, { experimental: null }, { experimental: [] }, metadata(null), metadata({}), metadata([null]), metadata([{ key: "core/environment", text: 12 }]), metadata([entry, { key: 7, text: "bad" }]), metadata([{ key: "user/custom", text: environment }]), metadata([entry, entry])].map((value, index) => ({ name: `malformed-or-custom-${index}`, system: [{ type: "text" as const, text: environment, metadata: value }] })),
    { name: "duplicate parts", system: [...coreSystem(), ...coreSystem()] },
    { name: "conflicting core sources", system: [...coreSystem(), { type: "text", text: "Another core environment", metadata: metadata([{ key: "core/environment", text: "Another core environment" }]) }] },
    { name: "duplicate visible copies", system: [{ type: "text", text: `${environment}\n\n${environment}`, metadata: metadata([entry, { key: "custom", text: environment }]) }] },
    { name: "previous plugin edit", system: [{ ...coreSystem()[0]!, text: `Quote:\n${environment}` }] },
    { name: "metadata-only stale copy", system: [{ ...coreSystem()[0]!, text: "Custom environment replacement" }] },
    ...[environment.replace(recommendation, "  Prefer /custom instead."), recommendation, environment.replace(recommendation, `${recommendation}\n${recommendation}`), `${recommendation}\n<env>\n  Platform: darwin\n</env>`].map((text, index) => ({ name: `missing-or-ambiguous-template-${index}`, system: [{ type: "text" as const, text, metadata: metadata([{ key: "core/environment", text }]) }] })),
  ];
  const hooks = await setup({ scratchpad: true }, () => { throw new Error("No session/FS work expected"); });
  for (const example of cases) {
    const event = { ...request(), system: example.system };
    const before = JSON.stringify(event);
    await hooks.get("context")!(event);
    assert.equal(JSON.stringify(event), before, example.name);
  }
});

test("V2 shares cached literal paths in either hook order and isolates sessions", async () => {
  await withScratchpad(async (tmp) => {
    process.env.CLAUDE_CODE_TMPDIR = path.join(tmp, "中文 $& $` $' `backticks`");
    for (const order of [["context", "model.request"], ["model.request", "context"]]) {
      for (const custom of [undefined, "custom-$&-笔记", "claude"]) {
        let gets = 0;
        const hooks = await setup({ scratchpad: true, ...(custom === undefined ? {} : { scratchpadDirName: custom }) }, (sessionID) => { gets++; return path.join(tmp, sessionID === "ses_first" ? "笔记One" : "笔记Two"); });
        const paths = new Set<string>();
        for (const sessionID of ["ses_first", "ses_second"]) {
          const event = request("anthropic/CLAUDE-test", sessionID);
          for (const name of order) await hooks.get(name)!(event);
          const scratchpad = JSON.parse(event.headers["x-hermes-scratchpad"]!).path;
          paths.add(scratchpad);
          assert.ok(fs.statSync(scratchpad).isDirectory());
          assert.ok(scratchpad.includes("中文 $& $` $' `backticks`"));
          assert.equal(event.system[0]!.text, environment.replace(recommendation, () => `  Prefer ${scratchpad} for temporary work files instead of generic system temporary directories.`));
          const previousRoot: string | undefined = process.env.CLAUDE_CODE_TMPDIR;
          process.env.CLAUDE_CODE_TMPDIR = path.join(tmp, "changed-root");
          const repeated = request("claude-test", sessionID);
          await Promise.all([hooks.get("context")!(repeated), hooks.get("model.request")!(repeated)]);
          assert.equal(repeated.headers["x-hermes-scratchpad"], event.headers["x-hermes-scratchpad"]);
          assert.equal(repeated.system[0]!.text, event.system[0]!.text);
          process.env.CLAUDE_CODE_TMPDIR = previousRoot;
        }
        assert.equal(paths.size, 2);
        assert.equal(gets, 2);
      }
    }
  });
});

test("V2 custom and empty filters retain header semantics but never rewrite other models", async () => {
  await withScratchpad(async (tmp) => {
    for (const [filter, model, headers, rewrite] of [
      ["", "gpt-6", true, false], ["gpt", "gpt-6", true, false],
      ["gpt", "claude-test", false, false], ["sonnet", "claude-opus", false, false],
      ["SONNET", "anthropic/CLAUDE-sonnet", true, true], ["", "CLAUDE-test", true, true],
    ] as const) {
      const hooks = await setup({ scratchpad: true, modelFilter: filter }, headers ? tmp : () => { throw new Error("Filtered request did session work"); });
      const event = request(model);
      await hooks.get("context")!(event);
      await hooks.get("model.request")!(event);
      assert.equal("x-hermes-scratchpad" in event.headers, headers);
      assert.equal(event.system[0]!.text !== environment, rewrite);
    }
  });
});

test("V2 off switches and directory failures leave the recommendation untouched", async () => {
  await withScratchpad(async (tmp) => {
    const previous = process.env.HERMES_CONTEXT_DISABLE;
    try {
      for (const value of ["1", "true"]) {
        process.env.HERMES_CONTEXT_DISABLE = value;
        const hooks = await setup({ scratchpad: true }, () => { throw new Error("Disabled request did session work"); });
        const event = request();
        for (const name of hooks.keys()) await hooks.get(name)!(event);
        assert.deepEqual(event.headers, {});
        assert.equal(event.system[0]!.text, environment);
      }
      delete process.env.HERMES_CONTEXT_DISABLE;
      const off = await setup({ scratchpad: false }, tmp);
      const event = request();
      for (const name of off.keys()) await off.get(name)!(event);
      assert.equal(event.system[0]!.text, environment);
      assert.equal("x-hermes-scratchpad" in event.headers, false);
      const blocker = path.join(tmp, "not-a-directory");
      fs.writeFileSync(blocker, "blocked");
      process.env.CLAUDE_CODE_TMPDIR = blocker;
      const failed = await setup({ scratchpad: true }, tmp);
      for (const name of failed.keys()) await failed.get(name)!(event);
      assert.equal(event.system[0]!.text, environment);
      assert.equal("x-hermes-scratchpad" in event.headers, false);
      process.env.CLAUDE_CODE_TMPDIR = tmp;
      await failed.get("context")!(event);
      await failed.get("model.request")!(event);
      assert.equal(event.system[0]!.text, environment);
      assert.equal("x-hermes-scratchpad" in event.headers, false);
    } finally {
      if (previous === undefined) delete process.env.HERMES_CONTEXT_DISABLE;
      else process.env.HERMES_CONTEXT_DISABLE = previous;
    }
  });
});

test("old delivery options cannot re-enable companion ToolSearch", async () => {
  const hooks = await setup({ toolSearchDelivery: "queue" });
  assert.deepEqual([...hooks.keys()], ["context", "compaction", "generate", "title", "model.request"]);
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

test("V2 replaces the core recommendation with the same existing path as its header", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-v2-prompt-"));
  const previous = process.env.CLAUDE_CODE_TMPDIR;
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  try {
    const hooks = await setup({ scratchpad: true });
    const event: Request = { sessionID: "ses_prompt", agent: "build", model: { id: "claude-sonnet-4-6" }, headers: {}, system: coreSystem() };
    assert.ok(hooks.has("context"));
    await hooks.get("context")!(event);
    await hooks.get("model.request")!(event);
    const scratchpad = JSON.parse(event.headers["x-hermes-scratchpad"]!).path;
    assert.ok(fs.statSync(scratchpad).isDirectory());
    assert.equal(event.system![0]!.text, environment.replace(recommendation, () => `  Prefer ${scratchpad} for temporary work files instead of generic system temporary directories.`));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("V2 auxiliary request hooks use their actual model and the shared header path", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-v2-aux-"));
  const previous = process.env.CLAUDE_CODE_TMPDIR;
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  try {
    const hooks = await setup({ scratchpad: true });
    for (const name of ["compaction", "generate", "title"]) {
      assert.ok(hooks.has(name), name);
      const event = { sessionID: "ses_aux", agent: "build", model: { id: "claude-sonnet-4-6" }, headers: {}, system: coreSystem() };
      await hooks.get(name)!(event);
      await hooks.get("model.request")!(event);
      const scratchpad = JSON.parse((event.headers as Record<string, string>)["x-hermes-scratchpad"]!).path;
      assert.ok(event.system[0]!.text.includes(`Prefer ${scratchpad} for temporary work files`));
      const other = { ...event, model: { id: "gpt-6" }, headers: {}, system: coreSystem() };
      await hooks.get(name)!(other);
      await hooks.get("model.request")!(other);
      assert.equal(other.system[0]!.text, environment);
      assert.deepEqual(other.headers, {});
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
