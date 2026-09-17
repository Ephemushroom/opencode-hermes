import type { Plugin as PluginNamespace } from "@opencode/plugin";
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

const OptionsSchema = z.object({
  environment: z.boolean().default(true),
  scratchpad: z.boolean().default(true),
  contextManagement: z.boolean().default(true),
  gitStatus: z.boolean().default(true),
  scratchpadDirName: z.string().min(1).default("claude"),
  extraEnvironment: z.record(z.string(), z.string()).optional(),
  gitTimeoutMs: z.number().int().positive().default(5000),
  modelFilter: z.string().default("claude"),
});

function disabled(): boolean {
  const value = process.env.HERMES_CONTEXT_DISABLE;
  return value === "1" || value === "true";
}

const HermesOpenCode2Plugin = {
  id: "ephemushroom.hermes.opencode2",
  setup: async (ctx) => {
    const options = OptionsSchema.parse(ctx.options);
    const directories = new Map<string, string>();
    const gitCache = new Map<string, GitSnapshot | null>();
    const scratchpadCache = new Map<string, string | null>();
    const gitRepoCache = new Map<string, boolean>();

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

      // ToolSearch belongs to Hermes' native Code Mode bridge. Keep the
      // client's native identity and tool inventory untouched.
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
