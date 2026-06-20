# Agent Control Phase 9 OpenHands Execution

## Scope

Phase 9 adds OpenHands as an executable direct provider adapter. Codex keeps the existing session-manager path, and OpenCode keeps the Phase 8 gated adapter behavior.

OpenHands remains disabled by default.

## Enable Flag

OpenHands execution requires this daemon environment flag:

```bash
OPENVIDE_ENABLE_OPENHANDS_PROVIDER=1
```

Accepted truthy values are `1`, `true`, `yes`, and `on`.

Without the flag, OpenHands may still be detected and reported as installed, but metadata reports:

- `status: "installed-but-disabled"`
- `enabled: false`
- `executable: false`

When the flag is set and OpenHands is detected, metadata reports:

- `status: "enabled"`
- `enabled: true`
- `executable: true`

When the flag is set but the command is unavailable, metadata reports `status: "unavailable"` and `executable: false`.

## Command Override

The adapter prefers an explicit command override:

```bash
OPENVIDE_OPENHANDS_COMMAND=/home/qreed/.local/bin/openhands
```

If the override is unset, the adapter falls back to:

```bash
command -v openhands
```

## Command Shape

Execution uses the manually validated headless JSON contract:

```bash
openhands -t <prompt> --headless --json --always-approve --exit-without-confirmation
```

The process runs with the team workspace as `cwd` when a team request provides one.

## JSON MessageEvent Parsing

OpenHands stdout can include banners, Rich warnings, status output, JSON event lines, conversation summaries, and conversation or resume IDs.

The adapter parses stdout line by line and treats only assistant or agent JSON MessageEvent payloads as candidate final responses. It selects the latest assistant or agent MessageEvent with textual content and ignores non-JSON status text such as banners, "Agent is working", conversation summaries, conversation ID lines, and goodbye text.

Malformed or non-JSON lines are tolerated when the process exits successfully and a final assistant MessageEvent is found.

## Timeout Behavior

OpenHands execution is bounded to 8 minutes.

Timeout failures return a failed provider result with timeout diagnostics. The daemon does not retry and does not fall back to Codex or OpenCode.

## Diagnostics

Provider diagnostics include:

- command path
- cwd
- sanitized args with prompt length instead of prompt content
- prompt length
- model arg applied state
- timeout in milliseconds
- exit code and signal
- timeout state
- stdout and stdout tail
- stderr and stderr tail
- parsed assistant event count
- conversation/resume ID when discovered

Team Chat orchestration run events and final timelines include compact diagnostic summaries from this provider result.

## Model Handling

The first OpenHands adapter does not pass a model flag. It relies on OpenHands' configured default model because this phase does not establish a stable CLI flag and model format for team member overrides.

OpenHands model mapping remains future work. Codex and OpenCode model handling are unchanged.

## Validation

Run from `apps/daemon`:

```bash
npm run build
node dist/providerMetadataSmoke.js
OPENVIDE_ENABLE_OPENCODE_PROVIDER=1 OPENVIDE_OPENCODE_COMMAND=/home/qreed/.opencode/bin/opencode node dist/opencodeProviderSmoke.js
OPENVIDE_ENABLE_OPENHANDS_PROVIDER=1 OPENVIDE_OPENHANDS_COMMAND=/home/qreed/.local/bin/openhands node dist/openhandsProviderSmoke.js
```

Run from the repository root:

```bash
git diff --check
```

The OpenHands smoke creates a temporary git repository under `/tmp`, asks OpenHands to reply exactly `OPENHANDS_ADAPTER_DIRECT_OK`, and fails if OpenHands reports failure, the response does not contain the expected token, or the temp repo has tracked file changes.

## Rollback And Disable

To disable OpenHands execution, remove the flag from the daemon environment and restart the daemon when convenient:

```bash
unset OPENVIDE_ENABLE_OPENHANDS_PROVIDER
```

After disablement, OpenHands may still be detected in metadata, but it is not executable and cannot be selected for new team execution. Existing OpenHands team members fail cleanly instead of falling back to another provider.

## Known Output Noise

OpenHands may emit non-fatal banner and terminal output on stdout or stderr, including Rich warnings, SDK or CLI banners, status lines, "Agent is working" messages, conversation summaries, goodbye text, and conversation/resume identifiers.

These are preserved in diagnostics but are not treated as the final assistant response.
