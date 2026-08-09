# Changelog

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
