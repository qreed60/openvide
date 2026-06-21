# Agent Control Phase 8 OpenCode Execution

## Scope

Phase 8 adds OpenCode as the first executable non-Codex provider adapter. Codex keeps the existing session-manager execution path. OpenHands remains planned and non-executable.

## Enable Flag

OpenCode execution is disabled by default.

Set this environment flag on the daemon process to enable it:

```bash
OPENVIDE_ENABLE_OPENCODE_PROVIDER=1
```

Accepted truthy values are `1`, `true`, `yes`, and `on`.

Without the flag, `team.metadata` can still report OpenCode as installed, but it reports:

- `status: "installed-but-disabled"` when `opencode` is detected
- `enabled: false`
- `executable: false`

When the flag is set and `opencode` is detected, metadata reports:

- `status: "enabled"`
- `enabled: true`
- `executable: true`

When the flag is set but the command is unavailable, metadata reports `status: "unavailable"` and `executable: false`.

## Command Shape

The adapter resolves the local command with:

```bash
command -v opencode
```

Execution uses the proven non-interactive contract:

```bash
opencode run <prompt>
```

The process runs with the team workspace as `cwd` when a team request provides one.

## Timeout Behavior

OpenCode execution is bounded to 5 minutes, matching the existing team session watcher ceiling. Timeout failures return a failed provider result with timeout diagnostics. The daemon does not retry or fall back to Codex.

## Stdout and Stderr

The adapter captures both streams.

- `stdout` is ANSI-stripped and trimmed to produce the final assistant response.
- `stderr` is ANSI-stripped and preserved as diagnostics or `errorText`.
- Stderr status/model lines are not used as the final response.

The structured result includes diagnostic command metadata, args, cwd, exit code, stdout, stderr, and timeout state for run-event consumers.

## Model Handling

OpenCode model override is conservative. The adapter only passes `--model` when the team member model is already in OpenCode-compatible `provider/model` format.

If a member model is missing or not in `provider/model` format, the adapter does not pass a model flag and relies on OpenCode's configured default model. Broader model mapping remains future work.

Codex model override behavior is unchanged and remains handled by the existing Codex session path.

## Team Execution

Teams using `codex`, `claude`, or `gemini` still create normal daemon sessions and execute through `sessionManager.sendTurn`.

Teams using `opencode` only execute when `OPENVIDE_ENABLE_OPENCODE_PROVIDER=1`. If an existing OpenCode team member is invoked while disabled, the provider result fails cleanly with an unavailable/disabled error. The daemon does not silently route OpenCode work to Codex.

## Rollback and Disable

To disable OpenCode execution, remove the flag from the daemon environment and restart the daemon when convenient:

```bash
unset OPENVIDE_ENABLE_OPENCODE_PROVIDER
```

After disablement, OpenCode may still be detected in metadata, but it is not executable and cannot be selected for new team execution. Existing OpenCode team members fail cleanly instead of falling back to another provider.

## Validation

Run from `apps/daemon`:

```bash
npm run build
node dist/providerMetadataSmoke.js
```

Run from the repository root:

```bash
git diff --check
```

Expected smoke coverage:

- OpenCode disabled and detected: `executable: false`
- OpenCode enabled and detected: `executable: true`
- OpenCode enabled but unavailable: `executable: false`
- OpenHands detected: `executable: false`
