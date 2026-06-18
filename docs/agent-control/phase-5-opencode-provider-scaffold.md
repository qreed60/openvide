# Agent Control Phase 5 OpenCode Provider Scaffold

## Scope

Phase 5 adds OpenCode as a planned provider in daemon team metadata only. OpenCode is not an executable team provider in this phase, even when a local `opencode` binary is detected.

Codex remains routed through the existing provider adapter and session manager path. OpenHands remains planned and non-executable.

## Local Detection

On this machine, safe bounded detection found:

- Command: `/home/qreed/.opencode/bin/opencode`
- Version: `1.17.6`
- Help summary includes:
  - `opencode completion`
  - `opencode acp`
  - `opencode mcp`
  - `opencode [project]`
  - `opencode attach <url>`
  - `opencode run [message..]`
  - `opencode debug`

The daemon exposes this through `team.metadata` as provider `opencode` with:

- `type: "planned"`
- `status: "installed-but-not-executable"` when installed
- `enabled: false`
- `executable: false`
- conservative capabilities with no edit/review/model override support enabled yet

If `opencode` is not installed, daemon metadata reports it as planned and unavailable. Missing OpenCode must not block daemon startup or team metadata calls.

## Before Execution Can Be Enabled

The next phase needs a concrete OpenCode execution contract before adding an adapter:

- Command contract: exact command and arguments for non-interactive turns.
- Working directory handling: how the daemon selects and validates `cwd`.
- Prompt input mode: argv prompt, stdin prompt, file prompt, or another stable API.
- Output capture: stdout/stderr format, streaming behavior, and final answer extraction.
- Timeout behavior: bounded turn runtime, cancellation, and partial-output handling.
- Resume/session behavior: session identifiers, continuation flags, and history mapping.
- Model selection: whether and how daemon member model values map to OpenCode `--model`.

Until those items are validated, OpenCode must remain visible but non-executable.
