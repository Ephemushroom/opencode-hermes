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
  scratchpadDirName: z.string().min(1).optional(),
  extraEnvironment: z.record(z.string(), z.string()).optional(),
  gitTimeoutMs: z.number().int().positive().default(5000),
  modelFilter: z.string().default("claude"),
});

function disabled(): boolean {
  const value = process.env.HERMES_CONTEXT_DISABLE;
  return value === "1" || value === "true";
}

const InstructionMetadata = z.object({
  experimental: z.object({
    instructions: z.array(z.object({ key: z.string(), text: z.string() })),
  }),
});

const temporaryRecommendation =
  /^  Prefer [^\r\n]+ over generic system temporary directories such as \/tmp; it is pre-created and approved for external access\.$/gm;

function scratchpadTarget(
  system: { text: string; metadata?: Record<string, unknown> | undefined }[],
) {
  const candidates = system.flatMap((part, index) => {
    const metadata = InstructionMetadata.safeParse(part.metadata);
    if (!metadata.success) return [];
    const instructions = metadata.data.experimental.instructions;
    return instructions
      .filter((entry) => entry.key === "core/environment")
      .map((entry) => ({ index, part, instructions, environment: entry.text }));
  });
  if (candidates.length !== 1) return;
  const { index, part, instructions, environment } = candidates[0]!;
  if (part.text !== instructions.map((entry) => entry.text).join("\n\n")) return;
  if (part.text.indexOf(environment) !== part.text.lastIndexOf(environment)) return;
  const block = environment.match(/(?:^|\n)<env>\n([^]*)\n<\/env>$/);
  if (!block) return;
  const lines = [...environment.matchAll(temporaryRecommendation)];
  if (lines.length !== 1 || !block[1]!.includes(lines[0]![0])) return;
  return { index, environment, line: lines[0]![0] };
}

const HermesOpenCode2Plugin = {
  id: "ephemushroom.hermes.opencode2",
  setup: async (ctx) => {
    const options = OptionsSchema.parse(ctx.options);
    const directories = new Map<string, string>();
    const gitCache = new Map<string, GitSnapshot | null>();
    const scratchpadCache = new Map<string, string | null>();
    const gitRepoCache = new Map<string, boolean>();
    const modelFilter = options.modelFilter.toLowerCase();
    const matchesModel = (id: string) =>
      modelFilter === "" || id.toLowerCase().includes(modelFilter);
    const directoryFor = async (sessionID: Parameters<typeof ctx.session.get>[0]["sessionID"]) => {
      let directory = directories.get(sessionID);
      if (directory === undefined) {
        const session = await ctx.session.get({ sessionID });
        directory = session.location.directory;
        directories.set(sessionID, directory);
      }
      return directory;
    };
    const scratchpadFor = async (sessionID: Parameters<typeof ctx.session.get>[0]["sessionID"]) => {
      const directory = await directoryFor(sessionID);
      let scratchpad = scratchpadCache.get(sessionID);
      if (scratchpad === undefined) {
        scratchpad = ensureScratchpadDir(directory, sessionID, options.scratchpadDirName);
        scratchpadCache.set(sessionID, scratchpad);
      }
      return scratchpad;
    };

    for (const hook of ["context", "compaction", "generate", "title"] as const) {
      await ctx.session.hook(hook, async (event) => {
        if (
          disabled() ||
          !options.scratchpad ||
          !matchesModel(event.model.id) ||
          !event.model.id.toLowerCase().includes("claude")
        )
          return;
        const target = scratchpadTarget(event.system);
        if (!target) return;
        const scratchpad = await scratchpadFor(event.sessionID);
        if (scratchpad === null) return;
        const part = event.system[target.index]!;
        event.system[target.index] = {
          ...part,
          text: part.text.replace(target.environment, () =>
            target.environment.replace(
              target.line,
              () =>
                `  Prefer ${scratchpad} for temporary work files instead of generic system temporary directories.`,
            ),
          ),
        };
      });
    }

    await ctx.session.hook("model.request", async (event) => {
      if (disabled() || !matchesModel(event.model.id)) return;
      const directory = await directoryFor(event.sessionID);

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
        const scratchpad = await scratchpadFor(event.sessionID);
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
