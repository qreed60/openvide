# Agent Control Phase 7 Model-Backed Provider Probes

## Scope

Phase 7 documents real model-backed contract probes for OpenCode and OpenHands only. It does not change runtime provider execution.

Codex execution remains unchanged. OpenCode and OpenHands remain non-executable team providers in this phase, and neither provider is wired into team execution.

## Probe Environment

Probe root:

- `/tmp/provider-contract-probes-real`

Probe directories:

- OpenCode: `/tmp/provider-contract-probes-real/opencode`
- OpenHands: `/tmp/provider-contract-probes-real/openhands`

Both probe directories were checked with `git status --short` after the bounded real probes. Git status was clean in both directories, with no tracked file changes.

## OpenCode Probe

Command:

```bash
timeout 240s opencode run "Do not edit files. Reply with exactly: OPENCODE_REAL_PROBE_OK"
```

Exit behavior:

- Exit code: `0`
- The command exited cleanly within the `240s` timeout.
- No timeout termination was observed.

Stdout behavior:

- Stdout included the requested final text:

```text
OPENCODE_REAL_PROBE_OK
```

Stderr/status behavior:

- Stderr included a model/status line:

```text
> agent · qwen3.6_35b_a3b_agent
```

File-change behavior:

- `git status --short` was clean after the probe.
- No tracked file changes were observed in `/tmp/provider-contract-probes-real/opencode`.

Model behavior seen:

- The probe ran against `qwen3.6_35b_a3b_agent`, as shown by the OpenCode status line.
- The model followed the no-edit instruction and returned the requested exact probe token.

Contract observation:

- `opencode run` accepts prompt-as-argv.
- It can run non-interactively.
- It exits cleanly for a bounded prompt-only task.
- It produces usable final text on stdout.

Output parsing strategy:

- Treat stdout as the primary source for the final assistant text for a first adapter.
- Trim surrounding process/status formatting conservatively and look for final non-empty assistant text.
- Keep stderr/status lines available as diagnostics, but do not require the status line to parse the final answer.
- Preserve timeout, exit code, stdout, and stderr metadata on every run for operator review.

## OpenHands Probe

Command:

```bash
timeout 360s openhands -t "Do not edit files. Reply with exactly: OPENHANDS_REAL_PROBE_OK" --headless --json --always-approve --exit-without-confirmation
```

Exit behavior:

- Exit code: `0`
- The command exited cleanly within the `360s` timeout.
- No timeout termination was observed.

Stdout behavior:

- Stdout included OpenHands initialization/status text.
- Stdout included JSON `MessageEvent` lines.
- Stdout included a final conversation summary and conversation ID.
- The final assistant JSON `MessageEvent` contained:

```text
OPENHANDS_REAL_PROBE_OK
```

Stderr/status behavior:

- Stderr/stdout included non-fatal Rich, Authlib, and OpenHands banner noise.
- The banner and warning output is not final assistant text.

File-change behavior:

- `git status --short` was clean after the probe.
- No tracked file changes were observed in `/tmp/provider-contract-probes-real/openhands`.

Model behavior seen:

- The model followed the no-edit instruction and returned the requested exact probe token inside an assistant `MessageEvent`.
- The useful completion was present in structured JSON event output rather than as the whole stdout stream.

Contract observation:

- OpenHands can run bounded, headless, noninteractive, and JSON output is parseable.
- Output parsing must extract assistant `MessageEvent` JSON rather than treating all stdout as final text.
- Non-fatal banner and dependency warning output must be tolerated.

Output parsing strategy:

- Parse stdout line-by-line and identify JSON event objects.
- Ignore non-JSON banner, warning, initialization, status, summary, and conversation-ID text for final answer extraction.
- Select assistant `MessageEvent` payloads as candidate assistant output.
- Use the final assistant `MessageEvent` containing textual content as the adapter's final answer.
- Preserve all raw stdout/stderr, parsed event metadata, timeout state, exit code, and conversation ID for diagnostics.
- Treat malformed JSON lines as non-fatal only when a valid final assistant `MessageEvent` is still found and the process exits successfully.

## Timeout And Cancellation Notes

OpenCode was bounded with `timeout 240s`; OpenHands was bounded with `timeout 360s`. Both probes completed with exit code `0`, so neither command exercised timeout kill handling.

Future executable adapters still need conservative timeout and cancel handling:

- enforce daemon-side bounded execution;
- capture partial stdout/stderr on timeout;
- report timeout as a provider failure instead of fabricating final text;
- avoid unsafe default approval or permission bypass flags;
- keep provider execution gated by provider metadata and explicit executable flags.

## Readiness Recommendation

OpenCode is ready for a first executable adapter in the next phase, guarded by provider metadata and an explicit executable flag.

OpenHands is ready for a parser-focused executable adapter only if implemented with JSON-event extraction and conservative timeout/cancel handling.

Both providers remain non-executable in Phase 7. This phase only documents the real model-backed contract probes and does not change daemon runtime behavior.
