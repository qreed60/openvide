# Agent Control Phase 10I: Queue Worker and Priority Controls

Phase 10I adds automatic daemon dispatch for eligible queue work and persistent global priority/reorder controls for not-yet-started queue items.

## Scope

Implemented:

- Automatic queue worker in the daemon.
- Worker inspect/enable/disable/tick IPC.
- Persistent queue priority and queue order fields on queue tasks and runs.
- Global queue item priority and move-to-top/move-to-bottom IPC.
- Queue status item projections with priority, order, rank, reorderability, and blocked reason.
- Dispatcher ordering by priority, explicit queue order, then creation time.

Not implemented in this phase:

- Board execution adapter.
- Plan execution adapter.
- Review gate execution.
- Legacy Board lifecycle restoration.
- Old TODO/DONE/REVIEW/APPROVED primary state.

## Worker

The daemon starts `teamQueueWorker` during daemon startup after queue/resource initialization and stops it during daemon shutdown.

Defaults:

- Enabled by default.
- Interval: `4000` ms.
- Minimum interval clamp: `1000` ms.

Environment overrides:

- `OPENVIDE_QUEUE_WORKER_ENABLED=0|false|no|off` disables automatic dispatch on daemon start.
- `OPENVIDE_QUEUE_WORKER_INTERVAL_MS=<ms>` changes the automatic tick interval.

IPC:

- `queue.worker.status`
- `queue.worker.enable`
- `queue.worker.disable`
- `queue.worker.tick_once`

Worker status includes:

- `enabled`
- `running`
- `intervalMs`
- `startedAt`
- `lastTickAt`
- `lastDispatchResult`
- `lastError`

The worker calls the same `dispatchTeamQueueOnce` path used by `team.queue.dispatch_once`. Manual dispatch remains available and unchanged.

## Dispatch Eligibility

The dispatcher and worker only dispatch visible, non-terminal work whose run is:

- `queued`
- `waiting_for_team_slot`
- `waiting_for_model`

The dispatcher skips deleted records, cancelled/failed/completed/interrupted records, and Board draft/blocked records. Phase 10I does not add Board or Plan execution adapters, so non-chat queue work remains queued or skipped according to existing adapter availability.

The dispatcher preserves the existing invariants:

- One active run per team.
- One active turn per provider:model resource.
- Provider execution timestamps are set only after resource acquisition.
- Waiting work has no `providerStartedAt` or `executionTimeoutStartedAt`.

## Priority and Ordering

Queue tasks and runs now persist:

- `priority`
- `queueOrder`

Dispatch order is:

1. Higher `priority` first.
2. Lower explicit `queueOrder` first.
3. Earlier `createdAt` first.

New queue items receive a stable `queueOrder` when created. Existing records without `queueOrder` fall back to their creation timestamp until moved.

Global priority IPC:

- `global.queue.item.set_priority`
- `global.queue.item.move_to_top`
- `global.queue.item.move_to_bottom`

Each command prefers `queueTaskId`; `queueRunId` is supported as a fallback when no task id is available.

Only not-yet-started items can be changed:

- queued tasks/runs
- waiting-for-team-slot runs
- waiting-for-model runs
- blocked Board metadata if the task/run is not running

Rejected:

- running
- completed
- failed
- cancelled
- interrupted
- deleted
- draft Board metadata

Updates persist to `team-queue.json`.

## Status Projection

`global.queue.status` and `team.queue.status` now include `items`, sorted in the same global queue order. Each item includes:

- `queueTaskId`
- `queueRunId`
- `teamId`
- `source`
- `title`
- `status`
- `taskStatus`
- `priority`
- `queueOrder`
- `rank`
- `createdAt`
- `queuedAt`
- `startedAt`
- `finishedAt`
- `reorderable`
- `reorderBlockedReason`

Deleted items are excluded from normal status ordering. Running items remain visible and report `reorderable: false`.

## Validation

Phase 10I validation bundle:

- `npm run build` in `apps/daemon`
- `node dist/teamQueueSmoke.js`
- `node dist/modelResourceSchedulerSmoke.js`
- `node dist/teamQueueDispatcherSmoke.js`
- `node dist/teamBoardQueueSmoke.js`
- `node dist/teamQueueDeleteSmoke.js`
- `node dist/teamQueueWorkerSmoke.js`
- `node dist/teamQueuePrioritySmoke.js`
- `git diff --check`
