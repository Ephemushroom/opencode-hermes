export type OpenCode2Delivery = "steer" | "queue";
export type OpenCode2DeliveryOption = OpenCode2Delivery | "immediate" | "deferred";

export type OpenCode2ToolDefinition = {
  readonly description: string;
  readonly input: Readonly<Record<string, unknown>>;
};

export type OpenCode2CatalogTool = OpenCode2ToolDefinition & {
  readonly originalName: string;
  readonly claudeName: string;
};

export type OpenCode2ToolCatalog = {
  readonly eager: readonly OpenCode2CatalogTool[];
  readonly deferred: readonly OpenCode2CatalogTool[];
  readonly forward: Readonly<Record<string, string>>;
  readonly reverse: Readonly<Record<string, string>>;
};

export type OpenCode2ToolSearchInput = {
  readonly query: string;
  readonly max_results?: number;
};

export type OpenCode2ToolSearchResult = {
  readonly content: string;
  readonly isError: boolean;
};

export type OpenCode2ToolSearchPrompt = {
  readonly sessionID: string;
  readonly text: string;
  readonly metadata: {
    readonly hermes: {
      readonly type: "tool_search_result";
      readonly delivery: OpenCode2Delivery;
      readonly isError: boolean;
    };
  };
  readonly delivery: OpenCode2Delivery;
  readonly resume: true;
};

const EAGER_MAPPINGS = [
  { originalName: "shell", claudeName: "Bash" },
  { originalName: "subagent", claudeName: "Agent" },
  { originalName: "edit", claudeName: "Edit" },
  { originalName: "glob", claudeName: "Glob" },
  { originalName: "grep", claudeName: "Grep" },
  { originalName: "read", claudeName: "Read" },
  { originalName: "skill", claudeName: "Skill" },
  { originalName: "write", claudeName: "Write" },
] as const;

const EAGER_ORDER = ["Agent", "Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Write"] as const;
const PROTOCOL_TOOLS = new Set(["ToolSearch", "DeferredToolPlaceholder"]);
const RESERVED_NAMES = new Set([...EAGER_ORDER, ...PROTOCOL_TOOLS]);
const MAXIMUM_RESULTS = 50;

export function normalizeOpenCode2Delivery(
  value: OpenCode2DeliveryOption | undefined,
): OpenCode2Delivery {
  switch (value) {
    case undefined:
    case "immediate":
    case "steer":
      return "steer";
    case "deferred":
    case "queue":
      return "queue";
  }
}

export function buildOpenCode2ToolSearchPrompt(
  sessionID: string,
  result: OpenCode2ToolSearchResult,
  delivery: OpenCode2Delivery,
): OpenCode2ToolSearchPrompt {
  return {
    sessionID,
    text: result.content,
    metadata: {
      hermes: {
        type: "tool_search_result",
        delivery,
        isError: result.isError,
      },
    },
    delivery,
    resume: true,
  };
}

export function buildOpenCode2ToolCatalog(
  tools: Readonly<Record<string, OpenCode2ToolDefinition>>,
): OpenCode2ToolCatalog {
  const forward: Record<string, string> = { ToolSearch: "ToolSearch" };
  const reverse: Record<string, string> = { ToolSearch: "ToolSearch" };
  const taken = new Set<string>(["ToolSearch"]);
  const catalog: OpenCode2CatalogTool[] = [];

  const entries = Object.entries(tools)
    .filter(([name]) => !PROTOCOL_TOOLS.has(name))
    .sort(([left], [right]) => {
      const leftApproved = eagerName(left) === undefined ? 1 : 0;
      const rightApproved = eagerName(right) === undefined ? 1 : 0;
      return leftApproved - rightApproved || ordinalCompare(left, right);
    });

  for (const [originalName, definition] of entries) {
    const approved = eagerName(originalName);
    const preferred = approved ?? pascalCase(originalName);
    const claudeName =
      approved !== undefined && !taken.has(preferred) ? preferred : allocateAlias(preferred, taken);
    taken.add(claudeName);
    forward[originalName] = claudeName;
    reverse[claudeName] = originalName;
    catalog.push({ originalName, claudeName, ...definition });
  }

  const eager = EAGER_ORDER.flatMap((name) => catalog.filter((tool) => tool.claudeName === name));
  const eagerNames = new Set(eager.map((tool) => tool.originalName));
  const deferred = catalog.filter((tool) => !eagerNames.has(tool.originalName));
  return { eager, deferred, forward, reverse };
}

export function executeOpenCode2ToolSearch(
  input: OpenCode2ToolSearchInput,
  catalog: OpenCode2ToolCatalog,
): OpenCode2ToolSearchResult {
  const maximum = input.max_results ?? 5;
  if (!Number.isInteger(maximum) || maximum <= 0) {
    return {
      content: 'ToolSearch input is invalid: "max_results" must be a positive integer.',
      isError: true,
    };
  }
  const limit = Math.min(maximum, MAXIMUM_RESULTS);
  const query = input.query.trim();

  if (query.startsWith("select:")) {
    const names = query
      .slice("select:".length)
      .split(",")
      .map((name) => name.trim())
      .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index);
    const selected: OpenCode2CatalogTool[] = [];
    for (const name of names) {
      const tool = catalog.deferred.find((candidate) => candidate.claudeName === name);
      if (tool === undefined)
        return { content: `Tool '${name}' is not a deferred tool.`, isError: true };
      selected.push(tool);
    }
    return { content: renderFunctions(selected.slice(0, limit)), isError: false };
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const required = terms
    .filter((term) => term.startsWith("+"))
    .map((term) => term.slice(1))
    .filter(Boolean);
  const optional = terms.filter((term) => !term.startsWith("+"));
  const ranked = catalog.deferred
    .map((tool, index) => ({
      tool,
      index,
      text: `${tool.claudeName} ${tool.description}`.toLowerCase(),
    }))
    .filter(({ text }) => required.every((term) => text.includes(term)))
    .filter(
      ({ text }) =>
        required.length > 0 ||
        optional.length === 0 ||
        optional.some((term) => text.includes(term)),
    )
    .sort(
      (left, right) =>
        rank(left.text, optional) - rank(right.text, optional) || left.index - right.index,
    )
    .slice(0, limit)
    .map(({ tool }) => tool);
  return { content: renderFunctions(ranked), isError: false };
}

function rank(text: string, terms: readonly string[]): number {
  const positions = terms.map((term) => text.indexOf(term)).filter((position) => position >= 0);
  return positions.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...positions);
}

function renderFunctions(tools: readonly OpenCode2CatalogTool[]): string {
  if (tools.length === 0) return "<functions></functions>";
  const rows = tools.map(
    (tool) =>
      `<function>${JSON.stringify({ description: tool.description, name: tool.claudeName, parameters: tool.input })}</function>`,
  );
  return `<functions>\n${rows.join("\n")}\n</functions>`;
}
function eagerName(originalName: string): string | undefined {
  return EAGER_MAPPINGS.find((mapping) => mapping.originalName === originalName)?.claudeName;
}

function pascalCase(name: string): string {
  const segments = name.split("_").filter(Boolean);
  return segments.length === 0
    ? name
    : segments.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1)).join("");
}

function ordinalCompare(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function allocateAlias(preferred: string, taken: Set<string>): string {
  if (!RESERVED_NAMES.has(preferred) && !taken.has(preferred)) return preferred;
  for (let counter = 2; ; counter += 1) {
    const suffix = `_${counter}`;
    const candidate = `${preferred.slice(0, 128 - suffix.length)}${suffix}`;
    if (!taken.has(candidate) && !RESERVED_NAMES.has(candidate)) return candidate;
  }
}
