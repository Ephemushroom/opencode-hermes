import type { Plugin as PluginNamespace } from "@opencode-ai/plugin-v2";
import { z } from "zod";

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
} from "./lib.js";
import {
  buildOpenCode2ToolCatalog,
  buildOpenCode2ToolSearchPrompt,
  executeOpenCode2ToolSearch,
  normalizeOpenCode2Delivery,
  type OpenCode2ToolCatalog,
  type OpenCode2ToolDefinition,
} from "./v2-lib.js";

const CLIENT_FAMILY_HEADER = "x-hermes-client-family";
const TOOL_PROTOCOL_HEADER = "x-hermes-tool-protocol-version";
const TOOL_DELIVERY_HEADER = "x-hermes-tool-delivery";
const CLIENT_FAMILY = "opencode2";
const TOOL_PROTOCOL_VERSION = "1";

const OptionsSchema = z.object({
  environment: z.boolean().default(true),
  scratchpad: z.boolean().default(true),
  contextManagement: z.boolean().default(true),
  gitStatus: z.boolean().default(true),
  scratchpadDirName: z.string().min(1).default("claude"),
  extraEnvironment: z.record(z.string(), z.string()).optional(),
  gitTimeoutMs: z.number().int().positive().default(5000),
  modelFilter: z.string().default("claude"),
  toolSearchDelivery: z.enum(["steer", "queue", "immediate", "deferred"]).default("immediate"),
});

const ToolSearchInputSchema = z.object({
  query: z.string(),
  max_results: z.number().int().positive().optional(),
});

const JsonObjectSchema = z.record(z.string(), z.unknown());

const ToolSearchDefinition = {
  name: "ToolSearch",
  description:
    "Search the deferred tool catalog exposed through the Hermes Claude Code compatibility layer.",
  input: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "number", default: 5 },
    },
    required: ["query", "max_results"],
    additionalProperties: false,
  },
  options: { codemode: false },
} as const;

function disabled(): boolean {
  const value = process.env.HERMES_CONTEXT_DISABLE;
  return value === "1" || value === "true";
}

const HermesOpenCode2Plugin = {
  id: "ephemushroom.hermes.opencode2",
  setup: async (ctx) => {
    const options = OptionsSchema.parse(ctx.options);
    const delivery = normalizeOpenCode2Delivery(options.toolSearchDelivery);
    const catalogs = new Map<string, OpenCode2ToolCatalog>();
    const directories = new Map<string, string>();
    const gitCache = new Map<string, GitSnapshot | null>();
    const scratchpadCache = new Map<string, string | null>();
    const gitRepoCache = new Map<string, boolean>();

    await ctx.tool.transform((tools) => {
      tools.add({
        ...ToolSearchDefinition,
        execute: async (rawInput, context) => {
          const parsed = ToolSearchInputSchema.parse(rawInput);
          const input =
            parsed.max_results === undefined
              ? { query: parsed.query }
              : { query: parsed.query, max_results: parsed.max_results };
          const catalog = catalogs.get(context.sessionID);
          const result =
            catalog === undefined
              ? { content: "<functions></functions>", isError: true }
              : executeOpenCode2ToolSearch(input, catalog);

          await ctx.session.prompt(
            buildOpenCode2ToolSearchPrompt(context.sessionID, result, delivery),
          );

          return {
            content: `<hermes-tool-search delivery="${delivery}" status="${result.isError ? "error" : "scheduled"}"/>`,
            metadata: { delivery, isError: result.isError },
          };
        },
      });
    });

    await ctx.session.hook("context", (event) => {
      const definitions: Record<string, OpenCode2ToolDefinition> = {};
      for (const [name, tool] of Object.entries(event.tools)) {
        definitions[name] = {
          description: tool.description,
          input: JsonObjectSchema.parse(tool.input),
        };
      }
      catalogs.set(event.sessionID, buildOpenCode2ToolCatalog(definitions));
    });

    await ctx.session.hook("model.request", async (event) => {
      if (disabled()) return;
      const modelFilter = options.modelFilter.toLowerCase();
      if (modelFilter !== "" && !event.model.id.toLowerCase().includes(modelFilter)) return;

      let directory = directories.get(event.sessionID);
      if (directory === undefined) {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        directory = session.location.directory;
        directories.set(event.sessionID, directory);
      }

      event.headers[CLIENT_FAMILY_HEADER] = CLIENT_FAMILY;
      event.headers[TOOL_PROTOCOL_HEADER] = TOOL_PROTOCOL_VERSION;
      event.headers[TOOL_DELIVERY_HEADER] = delivery;
      event.headers[HEADER_VERSION] = CONTRACT_VERSION;

      let snapshot = gitCache.get(event.sessionID);
      if (snapshot === undefined && (options.gitStatus || options.environment)) {
        snapshot = await gitSnapshot(directory, options.gitTimeoutMs);
        gitCache.set(event.sessionID, snapshot);
      }

      if (options.environment) {
        let repo = gitRepoCache.get(directory);
        if (repo === undefined) {
          repo =
            snapshot !== null && snapshot !== undefined
              ? true
              : await isGitRepo(directory, options.gitTimeoutMs);
          gitRepoCache.set(directory, repo);
        }
        event.headers[HEADER_ENVIRONMENT] = toHeaderJson(
          buildEnvironment({
            agent: event.agent,
            cwd: directory,
            isGitRepo: repo,
            ...(options.extraEnvironment === undefined ? {} : { extra: options.extraEnvironment }),
          }),
        );
      }

      if (options.scratchpad) {
        let scratchpad = scratchpadCache.get(event.sessionID);
        if (scratchpad === undefined) {
          scratchpad = ensureScratchpadDir(directory, event.sessionID, options.scratchpadDirName);
          scratchpadCache.set(event.sessionID, scratchpad);
        }
        if (scratchpad !== null)
          event.headers[HEADER_SCRATCHPAD] = toHeaderJson({ path: scratchpad });
      }

      if (options.contextManagement) event.headers[HEADER_CONTEXT_MANAGEMENT] = "true";
      if (options.gitStatus && snapshot !== null && snapshot !== undefined) {
        event.headers[HEADER_GIT_STATUS] = toHeaderJson(snapshot);
      }
    });
  },
} satisfies PluginNamespace.Plugin;

export default HermesOpenCode2Plugin;
export { HermesOpenCode2Plugin };
