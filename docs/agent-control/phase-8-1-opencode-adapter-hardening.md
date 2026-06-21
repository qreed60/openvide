# Agent Control Phase 8.1 OpenCode Adapter Hardening

## Scope

Phase 8.1 hardens the gated OpenCode execution adapter and adds direct smoke diagnostics. It does not change Codex routing, daemon session execution, OpenHands execution status, service files, bridge tokens, or run queue behavior.

OpenCode remains disabled by default and only executes when:

```bash
OPENVIDE_ENABLE_OPENCODE_PROVIDER=1
```

## Observed Starting Point

A service-like environment probe succeeded outside the daemon adapter path:

```bash
env -i HOME=/home/qreed USER=qreed PATH=/home/qreed/.opencode/bin:/home/qreed/.local/bin:/usr/local/bin:/usr/bin:/bin OPENVIDE_ENABLE_OPENCODE_PROVIDER=1 OPENAI_BASE_URL=http://127.0.0.1:1234/v1 CODEX_HOME=/home/qreed/.codex-local-openhands timeout 300s opencode run "Do not edit files. Reply with exactly: OPENCODE_SERVICE_ENV_PROBE_OK"
```

That probe exited `0` and returned `OPENCODE_SERVICE_ENV_PROBE_OK` on stdout, with only a model/status line on stderr.

The follow-up Team Chat run using an OpenCode Probe member timed out after 300 seconds. Because the direct command worked, the likely failure area was the daemon adapter or team execution diagnostics, not OpenCode availability in the service environment.

## Command Override

The OpenCode adapter now prefers an explicit command override before falling back to `command -v opencode`:

```bash
OPENVIDE_OPENCODE_COMMAND=/home/qreed/.opencode/bin/opencode
```

Use this in daemon/service environments when PATH differs from the interactive shell. If the variable is unset, the existing PATH-based discovery remains in place.

## Adapter Diagnostics

OpenCode adapter diagnostics include prompt-free startup and failure details:

- command path
- cwd
- sanitized args shape with prompt length instead of prompt content
- whether a model arg was applied
- timeout in milliseconds
- exit code, signal, and process error
- stdout and stderr
- stdout and stderr tails
- timed-out state

Team Chat orchestration run events now carry a compact `diagnostics` field for completed lead/member turns, so the UI timeline can expose command/cwd/timeout/stdout-tail/stderr-tail data without logging the full prompt.

## Direct Adapter Smoke

Run from `apps/daemon` after building:

```bash
OPENVIDE_ENABLE_OPENCODE_PROVIDER=1 OPENVIDE_OPENCODE_COMMAND=/home/qreed/.opencode/bin/opencode node dist/opencodeProviderSmoke.js
```

The smoke script creates a temporary git repository under `/tmp`, calls `executeProviderTurn` with an OpenCode member, and asks OpenCode to reply exactly:

```text
OPENCODE_ADAPTER_DIRECT_OK
```

The smoke prints provider result JSON and fails nonzero if:

- OpenCode reports a failed provider result
- the response does not contain `OPENCODE_ADAPTER_DIRECT_OK`
- the temporary repository has tracked file changes

The script is compiled with the daemon but is not imported by daemon startup.

## Next Debugging Steps

If the direct adapter smoke passes but Team Chat still times out:

1. Inspect the latest orchestrator run details and timeline diagnostics for the OpenCode member turn.
2. Compare `command`, `cwd`, `promptLength`, `modelArgApplied`, and `timeoutMs` against the direct smoke output.
3. Check `stdoutTail`, `stderrTail`, `exitCode`, `signal`, and `timedOut` for evidence of prompt parsing, model selection, or cwd-specific behavior.
4. Re-run a direct Team Chat probe with the same team working directory and member model override.
5. Only after diagnostics identify a queue or orchestration-level stall, investigate run queue behavior in a later phase.

## Validation

Run from `apps/daemon`:

```bash
npm run build
node dist/providerMetadataSmoke.js
OPENVIDE_ENABLE_OPENCODE_PROVIDER=1 OPENVIDE_OPENCODE_COMMAND=/home/qreed/.opencode/bin/opencode node dist/opencodeProviderSmoke.js
```

Run from the repository root:

```bash
git diff --check
```
