# Agent Control Phase 10A: Queue Foundation

Phase 10A adds daemon-only queue data structures and a durable JSON store for future team task and run scheduling. It does not dispatch work, lock resources, or change Team Chat, Codex, OpenCode, or OpenHands execution behavior.

## State File

The queue store writes one JSON document:

```text
~/.openvide-daemon/team-queue.json
```

The store module exposes load/save/update helpers and status summaries from `apps/daemon/src/teamQueueStore.ts`.

## Shared Queue Model

The schema is defined in `apps/daemon/src/teamQueueTypes.ts` and is intentionally source-neutral so Board tasks, Plan-generated tasks, Chat-submitted runs, scheduler work, and manual runs can share one model.

### Task

A task is a durable work item owned by a team.

- `source`: `board | plan | chat | scheduler | manual`
- `teamId`: owning team
- `status`: queue-level task status
- `sourceRef`: optional board task, plan revision, message, or schedule reference
- `runIds`: run attempts created from the task

### Run

A run is one execution attempt for a task.

- `teamId` and `taskId`: ownership links
- `status`: `queued | waiting_for_team_slot | waiting_for_model | running | completed | failed | cancelled | interrupted`
- `route`: member route observed for the run
- `currentMember`, `currentTurnId`, `currentState`: current execution state
- `turnIds`: member turns within the run

### Turn

A turn is one member execution within a run.

- `provider`: member provider (`codex`, `opencode`, `openhands`, or existing team tools)
- `model`: optional model name
- `resourceKey`: provider/model execution slot key
- `queuedAt`, `startedAt`, `providerStartedAt`, `finishedAt`
- `executionTimeoutStartedAt`: reserved for the instant provider execution actually starts

The timeout invariant is represented by separate waiting states and provider-start timestamps: queued turns, `waiting_for_team_slot`, and `waiting_for_model` turns do not imply execution has started.

### Resource

A resource is a placeholder for a future provider/model execution slot.

- `key`: `provider:model`, for example `codex:qwen35_2b` or `openhands:default`
- `provider`, `model`
- `status`: `available | reserved | running | disabled`
- `activeTurnId`
- `queuedTurnIds`

Phase 10A stores resource placeholders only. It does not enforce locking.

## Startup Recovery

`loadTeamQueueState()` recovers stale active state by default. This handles a daemon restart after a prior process died while queue records were active:

- running turns become `interrupted`
- running runs become `interrupted`
- running tasks with only interrupted run attempts become `interrupted`
- run `currentMember` and `currentTurnId` are cleared
- resource `activeTurnId` is cleared
- `running` or `reserved` resources with stale active turns become `available`

Queued and waiting states are left intact because their execution timeout has not started.

## IPC Visibility

Two read-only IPC commands expose queue summaries:

- `global.queue.status`
- `team.queue.status` with `teamId`

The response contains counts by task source/status, run status, turn status, resource status, active run IDs, active turn IDs, and the queue state file path.

## Non-Goals

Phase 10A does not:

- change Team Chat dispatch behavior
- start queue dispatching
- add provider/model resource locking
- modify Codex/OpenCode/OpenHands execution
- modify systemd or bridge token files
- modify `even-open-vide`
