# Phase 10D Queue Dispatcher

Phase 10D adds a daemon-side queue dispatcher for the durable Team Queue created in Phase 10A and the provider:model scheduler created in Phase 10B.

Queue state remains:

```text
~/.openvide-daemon/team-queue.json
```

## IPC Commands

- `team.queue.dispatch_once`
  - Runs one scheduler tick.
  - Selects eligible queued runs by task priority descending, then task creation time ascending.
  - Starts eligible queued Chat runs through the existing daemon Team Chat orchestrator.
  - Leaves unsafe or unsupported sources queued with a `dispatchBlockedReason`.
- `team.queue.dispatch_status`
  - Returns dispatcher readiness plus the current queue and model-resource summaries.
- `global.queue.status`
  - Unchanged.
- `team.queue.status`
  - Unchanged.
- `model.resources.status`
  - Unchanged.

## Dispatch Rules

The dispatcher uses the existing Task -> Run -> Turn -> Resource model:

- One active run is allowed per team.
- One active turn is allowed per provider:model resource.
- Runs blocked by team concurrency are kept as `waiting_for_team_slot`.
- Runs blocked by provider:model concurrency are kept as `waiting_for_model`.
- Provider execution is not started until the model resource is acquired.
- Resources are released in `finally` paths after success, failure, timeout, or exception.

Runs are considered in this order:

1. Higher task `priority` first.
2. Older task `createdAt` first when priorities match.

## Timeout Invariant

The dispatcher preserves the pre-execution timeout invariant:

- `queuedAt` does not start execution timeout.
- `waiting_for_team_slot` does not start execution timeout.
- `waiting_for_model` does not start execution timeout.
- `providerStartedAt` and `executionTimeoutStartedAt` are set only after a provider:model resource has been acquired and immediately before provider execution starts.

Waiting turns keep `providerStartedAt` and `executionTimeoutStartedAt` unset.

## Source Handling

- Chat tasks:
  - `team.chat.queue` creates queued Chat tasks.
  - `team.queue.dispatch_once` dispatches queued user-to-team Chat tasks through the existing daemon Team Chat orchestrator.
  - The live `team.message.send` path remains unchanged.
- Board/manual tasks:
  - Remain queued for now.
  - The dispatcher records `dispatchBlockedReason` until a scheduler-safe board task adapter can replace the legacy async `autoStartTask` path.
- Plan tasks:
  - Remain queued for now.
  - The dispatcher records `dispatchBlockedReason` until plan generation can be invoked through scheduler-owned turns instead of the legacy async plan path.

## Queue Events

Queue dispatch events are appended to the queue run metadata as `queueEvents`:

- `task_dispatch_started`
- `run_waiting_for_team_slot`
- `member_waiting_for_model`
- `model_resource_acquired`
- `run_started`
- `run_completed`
- `run_failed`
- `model_resource_released`

This keeps Phase 10D diagnostics in the durable queue state without adding a separate storage file.

## Validation

Compiled smoke coverage:

```text
npm run build
node dist/teamQueueSmoke.js
node dist/modelResourceSchedulerSmoke.js
node dist/teamQueueDispatcherSmoke.js
git diff --check
```
