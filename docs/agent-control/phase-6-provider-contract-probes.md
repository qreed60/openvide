# Agent Control Phase 6 Provider Contract Probes

## Scope

Phase 6 records provider detection metadata and execution-contract findings for OpenCode and OpenHands. Neither provider is executable in this phase.

Codex remains on the existing provider adapter and session manager path. OpenCode and OpenHands are exposed through `team.metadata` as planned providers only.

## Probe Environment

Probe directories:

- OpenCode: `/tmp/provider-contract-probes/opencode`
- OpenHands: `/tmp/provider-contract-probes/openhands`

The expected top-level stdout/stderr artifact files were not present during this validation:

- `/tmp/provider-contract-probes/opencode.stdout`
- `/tmp/provider-contract-probes/opencode.stderr`
- `/tmp/provider-contract-probes/openhands.stdout`
- `/tmp/provider-contract-probes/openhands.stderr`

Both probe directories contained a `.git` directory. `git status --short` was clean in both directories after the bounded command/help probes.

## OpenCode Findings

Probe commands used:

```bash
command -v opencode
opencode --version
opencode --help
opencode run --help
git status --short
```

Detection result:

- Command: `/home/qreed/.opencode/bin/opencode`
- Version observed on this machine: `1.17.8`
- The previous Phase 5 baseline recorded `1.17.6`; the local install has changed since then.

Help findings:

- `opencode run [message..]` is the documented non-interactive command shape.
- Prompt-as-argv appears supported by the `message` positional array.
- `--model` is documented for `opencode run` and uses `provider/model` format.
- `--format` supports `default` and `json`; JSON appears available for raw event output.
- `--continue`, `--session`, and `--fork` are documented for session continuation.
- `--dir` is documented for working directory selection.
- `--dangerously-skip-permissions` exists, but must not be used by default in a daemon adapter.

Exit/stdout/stderr behavior:

- `opencode --version` exited `0` and printed `1.17.8` to stdout.
- `opencode --help` exited `0` and printed command/help text to stdout.
- `opencode run --help` exited `0` and printed run-specific help text to stdout.
- No stderr output was observed in the captured terminal output for the bounded help/version probes.
- No TTY was required for help/version probes.

File behavior:

- The bounded help/version probes did not change tracked files in `/tmp/provider-contract-probes/opencode`.
- Actual model-backed `opencode run ...` execution was not run by this phase. Phase 7 documents the later real model-backed OpenCode probe.

Execution readiness:

- OpenCode is not ready for executable adapter implementation yet.
- The command surface looks promising because it has argv prompt input, JSON output, `--model`, and session flags, but a real adapter still needs a bounded model-backed probe that proves final-answer extraction, cancellation, permission behavior, cwd handling, and session continuation without unsafe defaults.

## OpenHands Findings

Probe commands used:

```bash
command -v openhands
openhands --version
openhands --help
git status --short
```

Detection result:

- Command: `/home/qreed/.local/bin/openhands`
- Version observed on this machine:
  - `OpenHands SDK v1.21.0`
  - `OpenHands CLI 1.16.0`

Help findings:

- `--task TASK` / `-t TASK` is documented for initial task text.
- `--file FILE` is documented for file-based task input.
- `--headless` is documented, and requires `--task` or `--file`.
- `--json` is documented for JSONL event output in headless mode.
- `--resume`, `--last`, and `view` are documented for existing conversations.
- Model selection is not a first-class CLI flag in the top-level help. `--override-with-envs` is documented and mentions `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`, but this phase does not introduce environment-based model routing.
- `--always-approve` / `--yolo` exists, but must not be used by default in a daemon adapter.

Exit/stdout/stderr behavior:

- `openhands --version` exited `0`.
- `openhands --help` exited `0`.
- Both commands printed LiteLLM/Authlib warnings before the OpenHands banner/help in the captured terminal output. The LiteLLM warning was caused by restricted network access while fetching the remote model cost map, then it fell back to a local backup.
- The commands printed the OpenHands SDK banner and CLI version/help text.
- No TTY was required for help/version probes.

File behavior:

- The bounded help/version probes did not change tracked files in `/tmp/provider-contract-probes/openhands`.
- Actual model-backed `openhands --headless --json -t ...` execution was not run by this phase. Phase 7 documents the later real model-backed OpenHands probe.

Execution readiness:

- OpenHands is not ready for executable adapter implementation yet.
- The command surface has task input and headless JSONL output, but a real adapter still needs a bounded model-backed probe that proves JSONL event semantics, final-answer extraction, cwd/worktree safety, approval behavior, cancellation, resume behavior, and model-selection handling without relying on daemon-wide `OPENAI_MODEL` or unguarded environment overrides.

## Metadata Contract

`team.metadata` exposes both planned providers:

- `id: "opencode"`
- `id: "openhands"`

Each planned provider includes:

- `type: "planned"`
- `enabled: false`
- `executable: false`
- `planned: true`
- `available: true` when the command is detected, otherwise `false`
- `status: "installed-but-not-executable"` when detected, otherwise `planned`
- bounded `detection` metadata with command, version/help summary where available, and safe failure metadata when unavailable
- conservative capabilities that do not enable execution

Missing OpenCode or OpenHands commands must not block daemon startup or `team.metadata`.

## Phase 6 Decision

OpenCode and OpenHands remain metadata-only providers. Both are visible to the UI as planned providers, and installed local commands can be distinguished from unavailable commands through `available`, `status`, and `detection`.

Neither provider is executable, and neither is wired into team member execution in this phase.
