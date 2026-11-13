import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parent = resolve(process.argv[2] ?? join(tmpdir(), "opencode"));
mkdirSync(parent, { recursive: true });
const evidence = realpathSync(mkdtempSync(join(parent, "hermes-v2-live-")));
const runtime = join(evidence, "runtime");
const binary = process.env.QA_OPENCODE_BIN ?? "/Applications/OpenCode.app/Contents/Resources/opencode-cli";
const requests = [];
const processes = [];
const failures = [];
let scenario;
console.log(`Evidence: ${evidence}`);

function responseEvents(model, call) {
  const id = `resp_${requests.length}`;
  const item = `item_${requests.length}`;
  const events = [{ type: "response.created", response: { id, created_at: Math.floor(Date.now() / 1000), model } }];
  if (call) {
    const args = JSON.stringify({ path: "fixture.txt" });
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: item, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: item, call_id: item, name: "read", arguments: args, status: "completed" } },
    );
  } else {
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: item } },
      { type: "response.output_text.delta", item_id: item, output_index: 0, delta: "HERMES_QA_DONE" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: item } },
    );
  }
  events.push({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  return events;
}

const mock = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/responses");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.startsWith("x-hermes-") || name.startsWith("x-opencode-") || name === "user-agent"));
    const record = { scenario: scenario.name, headers, body };
    requests.push(record);
    appendFileSync(join(evidence, "requests.ndjson"), JSON.stringify(record) + "\n");
    assert.ok(requests.length <= 20, "Unexpected request loop");
    const hasRead = body.tools?.some((tool) => tool.name === "read");
    const hasResult = body.input?.some((item) => item.type === "function_call_output");
    const call = hasRead && !hasResult;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const event of responseEvents(body.model, call)) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    failures.push(String(error));
    res.writeHead(500).end("Mock failed");
  }
});

async function run(name, args, fixture) {
  const child = spawn(binary, args, { cwd: fixture.project, env: fixture.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const record = { name, args, pid: child.pid };
  processes.push(record);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
    output += data;
    appendFileSync(join(evidence, `${name}.log`), data);
  });
  const kill = () => {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const timeout = setTimeout(kill, 90000);
  try {
    const [code, signal] = await once(child, "close");
    Object.assign(record, { code, signal, closed: true });
    assert.equal(code, 0, `${name}: ${output}`);
    return output;
  } finally {
    clearTimeout(timeout);
    kill();
  }
}

try {
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const mockURL = `http://127.0.0.1:${mock.address().port}/v1`;
  for (scenario of [
    { name: "claude", model: "claude-hermes-qa", rewrite: true },
    { name: "non-claude", model: "gpt-hermes-qa", rewrite: false },
    { name: "disabled", model: "claude-hermes-qa", rewrite: false, disabled: true },
  ]) {
    const home = join(runtime, scenario.name, "home");
    const project = join(home, "project");
    const config = join(home, "config");
    const plugin = join(home, "plugin");
    for (const directory of [project, join(config, "opencode"), plugin, join(home, "tmp")]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(plugin, "index.ts"), `export { default } from ${JSON.stringify(join(root, "dist/v2.js"))};\n`);
    writeFileSync(join(project, "fixture.txt"), "HERMES_QA_NATIVE_READ_RESULT\n");
    const env = {
      PATH: process.env.PATH,
      HOME: home, USERPROFILE: home, PWD: project, TMPDIR: join(home, "tmp"),
      XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
      OPENCODE_TEST_HOME: home, OPENCODE_DB: join(home, "isolated.db"),
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FREE_MODELS: "1",
      CLAUDE_CODE_TMPDIR: join(home, "scratchpads"), HERMES_QA_KEY: "fake-local-only",
      ...(scenario.disabled ? { HERMES_CONTEXT_DISABLE: "1" } : {}),
    };
    const settings = {
      plugins: ["-opencode.provider.ollama", "-opencode.provider.lmstudio", "-opencode.provider.vllm", { package: plugin, options: { environment: false, gitStatus: false } }],
      model: `hermes-qa/${scenario.model}`, default_agent: "build", update: "disable",
      providers: { "hermes-qa": {
        name: "Local Hermes QA", env: ["HERMES_QA_KEY"], package: "@opencode/ai/providers/openai-compatible/responses",
        settings: { baseURL: mockURL, apiKey: "{env:HERMES_QA_KEY}" },
        models: { [scenario.model]: { capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 200000, output: 8192 } } },
      } },
    };
    writeFileSync(join(config, "opencode/opencode.json"), JSON.stringify(settings));
    writeFileSync(join(evidence, `${scenario.name}-isolation.json`), JSON.stringify({ project, env: { ...env, PATH: "[inherited executable search path]", HERMES_QA_KEY: "[dummy key]" }, settings }, null, 2));
    const fixture = { project, env };
    if (scenario.name === "claude") {
      assert.match((await run("version", ["--version"], fixture)).trim(), /^(?:opencode v)?2\.2\.7$/);
      await run("help", ["run", "--help"], fixture);
    }
    const paths = await run(`${scenario.name}-paths`, ["debug", "paths"], fixture);
    assert.ok(paths.includes(home), "Isolated home not in debug paths");
    const output = await run(scenario.name, ["run", "--standalone", "--auto", "--print-logs", "--agent", "build", "--model", `hermes-qa/${scenario.model}`, "Read fixture.txt and report HERMES_QA_DONE."], fixture);
    assert.ok(output.includes("HERMES_QA_DONE"));
    const captured = requests.filter((record) => record.scenario === scenario.name);
    const primary = captured.filter((record) => record.body.tools?.some((tool) => tool.name === "read"));
    assert.ok(primary.length >= 2, "Missing native tool continuation");
    assert.ok(primary.some((record) => JSON.stringify(record.body.input).includes("HERMES_QA_NATIVE_READ_RESULT")), "Native read result missing");
    for (const record of primary) {
      const text = record.body.instructions ?? "";
      assert.ok(text.includes("<env>"));
      assert.ok(record.headers["user-agent"]?.includes("opencode"), "Native identity missing");
      assert.ok(record.body.tools.some((tool) => tool.name === "execute"), "Native Code Mode missing");
      assert.ok(!record.body.tools.some((tool) => tool.name === "ToolSearch"));
      if (scenario.rewrite) {
        const scratchpad = JSON.parse(record.headers["x-hermes-scratchpad"]).path;
        assert.ok(statSync(scratchpad).isDirectory());
        assert.ok(text.includes(`  Prefer ${scratchpad} for temporary work files instead of generic system temporary directories.`));
        assert.ok(!text.includes("over generic system temporary directories such as /tmp; it is pre-created and approved for external access."));
      } else {
        assert.ok(/  Prefer [^\n]+\/opencode over generic system temporary directories such as \/tmp; it is pre-created and approved for external access\./.test(text));
        assert.ok(!Object.keys(record.headers).some((name) => name.startsWith("x-hermes-")));
      }
    }
    writeFileSync(join(evidence, `${scenario.name}-result.json`), JSON.stringify({ verdict: "PASS", requests: captured.length, primaryRequests: primary.length, toolContinuation: true, rewrite: scenario.rewrite }, null, 2));
  }
  assert.deepEqual(failures, []);
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ verdict: "PASS", version: "2.2.7", requests: requests.length, binary, bundleSha256: createHash("sha256").update(readFileSync(join(root, "dist/v2.js"))).digest("hex") }, null, 2));
  console.log("PASS: isolated 2.2.7 final requests, native tool continuations, Claude rewrite and non-Claude/disabled preservation");
} catch (error) {
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ verdict: "FAIL", error: String(error), failures }, null, 2));
  throw error;
} finally {
  mock.closeAllConnections();
  await new Promise((done) => mock.close(done));
  writeFileSync(join(evidence, "processes.json"), JSON.stringify(processes, null, 2));
  rmSync(runtime, { recursive: true, force: true });
}
