import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOpenCode2ToolCatalog,
  buildOpenCode2ToolSearchPrompt,
  executeOpenCode2ToolSearch,
  normalizeOpenCode2Delivery,
} from "../src/v2-lib.js";

const tools = {
  shell: {
    description: "Run a shell command",
    input: { type: "object", properties: { command: { type: "string" } } },
  },
  subagent: {
    description: "Run a subagent",
    input: { type: "object", properties: { prompt: { type: "string" } } },
  },
  session_search: {
    description: "Search prior sessions",
    input: { type: "object", properties: { query: { type: "string" } } },
  },
  ToolSearch: {
    description: "Hermes protocol tool",
    input: { type: "object" },
  },
} as const;

test("normalizeOpenCode2Delivery: legacy names map to the current API enum", () => {
  assert.equal(normalizeOpenCode2Delivery(undefined), "steer");
  assert.equal(normalizeOpenCode2Delivery("immediate"), "steer");
  assert.equal(normalizeOpenCode2Delivery("deferred"), "queue");
  assert.equal(normalizeOpenCode2Delivery("steer"), "steer");
  assert.equal(normalizeOpenCode2Delivery("queue"), "queue");
});

test("buildOpenCode2ToolSearchPrompt: selected delivery reaches the session API payload", () => {
  const prompt = buildOpenCode2ToolSearchPrompt(
    "ses_v2",
    { content: "<functions></functions>", isError: false },
    "queue",
  );

  assert.deepEqual(prompt, {
    sessionID: "ses_v2",
    text: "<functions></functions>",
    metadata: { hermes: { type: "tool_search_result", delivery: "queue", isError: false } },
    delivery: "queue",
    resume: true,
  });
});

test("buildOpenCode2ToolCatalog: V2 shell and subagent occupy Claude Code eager slots", () => {
  const catalog = buildOpenCode2ToolCatalog(tools);

  assert.deepEqual(
    catalog.eager.map((tool) => tool.claudeName),
    ["Agent", "Bash"],
  );
  assert.deepEqual(
    catalog.deferred.map((tool) => tool.claudeName),
    ["SessionSearch"],
  );
});

test("buildOpenCode2ToolCatalog: protocol ToolSearch is excluded from searchable tools", () => {
  const catalog = buildOpenCode2ToolCatalog(tools);

  assert.equal(catalog.forward["ToolSearch"], "ToolSearch");
  assert.equal(
    catalog.deferred.some((tool) => tool.originalName === "ToolSearch"),
    false,
  );
});

test("executeOpenCode2ToolSearch: select query renders the Claude alias and original schema", () => {
  const catalog = buildOpenCode2ToolCatalog(tools);

  const result = executeOpenCode2ToolSearch(
    { query: "select:SessionSearch", max_results: 5 },
    catalog,
  );

  assert.equal(result.isError, false);
  assert.match(result.content, /<functions>/);
  assert.match(result.content, /"name":"SessionSearch"/);
  assert.match(result.content, /"query":\{"type":"string"\}/);
});

test("executeOpenCode2ToolSearch: eager tools cannot be selected as deferred tools", () => {
  const catalog = buildOpenCode2ToolCatalog(tools);

  const result = executeOpenCode2ToolSearch({ query: "select:Bash", max_results: 5 }, catalog);

  assert.equal(result.isError, true);
});
