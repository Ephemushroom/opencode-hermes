# Changelog

## [0.3.0] - 2026-09-17

- Target OpenCode 2.0.6's `@opencode/plugin` SDK
- Remove V2 ToolSearch registration, duplicate tool catalogs, companion tool headers,
  and synthetic result delivery; Hermes now bridges Claude ToolSearch to native Code Mode
- Keep environment reporting and native client identity intact; obsolete
  `toolSearchDelivery` options are ignored
- Upgrade Hermes to v0.4.8 before updating the plugin, then restart the OpenCode
  service. The V1 context adapter remains available through the unified entrypoint

## [0.2.0] - 2026-09-07

- Unify the root, `main`, and `/server` entrypoints with a plain
  `{ id, server, setup }` definition for OpenCode 1 and 2; no Effect rewrite needed
- Verify packed bare-package installation with OpenCode `1.18.29` and OpenCode2
  `0.0.0-beta-19192`, including context headers and a ToolSearch round trip
- Keep `HermesPlugin` callable for direct V1 integrations; the default export is
  now an object and requires a V1 host supporting `server()` modules
- Keep SDK dependencies available to consumers of the published declarations
- Require typechecking and both runtime build outputs in CI and releases

- Add the `@ephemushroom/opencode-hermes/v2` export for OpenCode2 beta
  `0.0.0-beta-18050`
- Register a direct ToolSearch plugin tool, mirror OpenCode2 `shell/subagent`
  aliases to Claude Code `Bash/Agent`, and deliver ToolSearch results through
  the local session API
- Accept `immediate/deferred` delivery names as aliases for the current
  `steer/queue` API enum
- Add versioned OpenCode2 client/tool-protocol headers for Hermes routing
- Use the bare package name in V2 configuration; the current beta treats npm
  subpath specifiers as local paths. `/v2` remains a programmatic export

## [0.1.3] - 2026-08-09

- Shell detection now mirrors Claude Code's `v6s()`: `$SHELL` (zsh/bash
  simplified) when set, fixed `"PowerShell"` on Windows without it, `"unknown"`
  elsewhere — `ComSpec` is never consulted (it is the system command
  interpreter, not the user's terminal)
- `x-hermes-environment`: drop `modelID`/`modelName` — the gateway reads the
  model from the request body's `model` field; the header now carries exactly
  what the `# Environment` block renders plus `agent`
- Gateway contract doc: add a turnkey C# block-builder example (§4.6) and fix
  stale field references

## [0.1.2] - 2026-08-09

Slim down the headers to what the gateway actually consumes:

- `x-hermes-scratchpad`: drop `sessionID` — it is already a path segment
- `x-hermes-environment`: drop `sessionID` and `providerID`; the block only
  renders `cwd` / `isGitRepo` / `platform` / `shell` / `osVersion` / `modelID` /
  `modelName`, and `agent` stays for the optional subagent policy
  (`extraEnvironment` can add anything back)

## [0.1.1] - 2026-08-09

- Switch release workflow to tokenless OIDC trusted publishing (drop the
  `NODE_AUTH_TOKEN` secret entirely)
- Make the `clean` script cross-platform so local publishes work on Windows

## [0.1.0] - 2026-08-09

Initial release.

- Reports Claude Code-style context as `x-hermes-*` request headers on every LLM
  call: environment facts, scratchpad directory, context-management flag, and a
  session-cached git startup snapshot
- Scratchpad path layout byte-compatible with Claude Code
  (`<tmpdir>/claude/<flattened-cwd>/<sessionID>/scratchpad`, created with mode 0o700)
- Git snapshot mirrors Claude Code: concurrent `status --short` / `log --oneline -n 5` /
  `config user.name`, `core.hooksPath=/dev/null` + `core.fsmonitor=` safety flags on
  ref probes, 2000-char status truncation, `(clean)` substitution, `user` omitted when empty
- ASCII-safe JSON header values (non-ASCII escaped as `\uXXXX`) so non-ASCII paths and
  filenames survive HTTP header transport
- Claude-only by default: headers are sent only when the model ID contains
  `claude` (configurable via `modelFilter`)
- Kill switch via `HERMES_CONTEXT_DISABLE=1`
- Gateway-side parsing and injection contract documented in
  [docs/gateway-contract.md](docs/gateway-contract.md)
