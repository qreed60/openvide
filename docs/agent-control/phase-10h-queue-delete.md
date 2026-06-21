# Phase 10H Queue Item Soft Delete

Phase 10H adds daemon-backed persistent soft delete for queue tasks, queue runs, and linked queue turns. The persistent source of truth remains:

```text
~/.openvide-daemon/team-queue.json
```

## IPC Command

`team.queue.item.delete`

Input:

```json
{
  "cmd": "team.queue.item.delete",
  "teamId": "team_id",
  "queueTaskId": "queue_task_id",
  "queueRunId": "queue_run_id",
  "reason": "optional reason"
}
```

`queueTaskId` is preferred. If only `queueRunId` is supplied, the daemon resolves the parent queue task from the run.

Return:

```json
{
  "ok": true,
  "queueTaskId": "queue_task_id",
  "queueRunIds": ["queue_run_id"],
  "deletedAt": "2026-06-20T00:00:00.000Z",
  "queueTask": {},
  "queueRuns": [],
  "queueStatus": {}
}
```

## Deleted State

Queue records are not physically removed. Deleted tasks, runs, and linked turns are retained with:

- `visibility: "deleted"`
- `deletedAt`
- `deletedBy`
- `deleteReason` when supplied

Title, description, source, source refs, metadata, and Chat prompt/message text are preserved so Chat can render a deleted-message placeholder from the tombstone record.

## Allowed Scope

Soft delete rejects active running work. It is allowed for non-running records, including queued, waiting, cancelled, failed, completed, interrupted, and blocked queue-backed work.

When queued or waiting work is deleted:

- linked queue runs are marked `cancelled` and `visibility: "deleted"`
- linked queued/waiting turns are marked `cancelled` and `visibility: "deleted"`
- non-running reserved resources owned by the deleted turn are released
- running resources are not released by delete

## Listing And Status

Normal history/list projections hide deleted queue records:

- `team.task.list`
- `team.run.list`
- queue-backed Board projections

List callers can pass `includeDeleted: true` to include tombstone records. Direct get commands still return deleted records by id.

`global.queue.status` and `team.queue.status` exclude deleted tasks/runs/turns from normal totals and status counts, and expose separate deleted counts in `queueStatus.deleted`.

## Dispatcher Behavior

The dispatcher skips deleted tasks and runs when selecting candidates. It also guards waiting/start/finish update paths so a tombstone cannot be moved back into queued/running status by a stale dispatch cycle.

## Validation

The delete smoke is:

```text
node dist/teamQueueDeleteSmoke.js
```

It covers delete by task id, delete by run id fallback, terminalizing waiting work, preserving Chat metadata, hiding deleted records from normal list/status output, dispatcher skip behavior, and rejecting running work.
