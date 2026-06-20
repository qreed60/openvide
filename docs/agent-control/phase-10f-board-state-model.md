# Phase 10F Board State Model

Phase 10F makes Agent Control Board items queue-backed. The persistent source of truth remains:

```text
~/.openvide-daemon/team-queue.json
```

The legacy per-team task files under `~/.openvide-daemon/teams/<teamId>/tasks/task_*.json` remain compatibility data for older `team.task.*` callers. Their lifecycle states are not the primary Board workflow.

## Board Item Schema

Board items are projected from queue tasks where `source` is `board`.

- `id`: Board item id stored in queue task metadata and `sourceRef.boardTaskId`
- `teamId`
- `title`
- `description`
- `source`: always `board`
- `executionStatus`
- `reviewStatus`
- `assignedMembers`
- `reviewerMembers`
- `priority`
- `queueTaskId`
- `queueRunIds`
- `createdAt`
- `updatedAt`
- `queuedAt`
- `startedAt`
- `finishedAt`
- `blockedReason`
- `reviewFeedback`

## Execution State

Execution state is derived from the queue task/run state plus queue-owned Board metadata:

- `draft`
- `queued`
- `waiting_for_team_slot`
- `waiting_for_model`
- `running`
- `completed`
- `failed`
- `cancelled`
- `interrupted`
- `blocked`

Queued, waiting, and draft Board items do not imply provider execution. `providerStartedAt` and `executionTimeoutStartedAt` remain turn-level fields and are set only when a provider turn actually starts.

## Review State

Review state is separate queue metadata and does not drive execution:

- `not_required`
- `pending_review`
- `approved`
- `revise`
- `rejected`

`team.board.item.create` defaults review state to `not_required`.

## IPC Commands

- `team.board.items.list`
- `team.board.item.get`
- `team.board.item.create`
- `team.board.item.cancel`
- `team.board.item.set_review_status`

`team.board.item.create` creates a queue task with `source=board`, a Board item id, Board metadata, and a queue run. New Board UI should target this command instead of the legacy `team.task.create` path.

## Legacy Board Lifecycle

The old task file statuses are deprecated as primary Board states:

- `todo`
- `done`
- `review`
- `approved`

Those values may still exist in legacy task files or older compatibility responses, but they do not override queue-backed `executionStatus` or queue-owned `reviewStatus`.

Phase 10F does not delete legacy task files and does not add new behavior around legacy review prompts. `team.task.create` remains available for compatibility.

## Dispatcher Boundary

This phase does not add an automatic dispatcher loop and does not change provider execution behavior. Board/manual queue tasks remain queued unless explicitly cancelled or marked as draft/blocked by queue-owned Board metadata. Draft and blocked Board items are skipped by the dispatcher.

## Validation

Compiled smoke coverage:

```text
npm run build
node dist/teamQueueSmoke.js
node dist/modelResourceSchedulerSmoke.js
node dist/teamQueueDispatcherSmoke.js
node dist/teamBoardQueueSmoke.js
git diff --check
```
