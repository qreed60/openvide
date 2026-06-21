# Phase 10C Queue Producers

Phase 10C adds daemon-side producers for the durable team queue introduced in Phase 10A and the provider:model resource scheduler introduced in Phase 10B.

The queue state remains a single shared model at:

```text
~/.openvide-daemon/team-queue.json
```

## IPC Commands

Task producers:

- `team.task.create`
  - Creates a queued durable task and run.
  - Defaults to `source: "board"` when no source is supplied.
  - Accepts `source: "board"` or `source: "manual"` for Board/manual task creation.
  - Accepts `subject` or `title`.
  - Accepts optional `description` or `prompt`.
  - Accepts optional `assignedMemberNames`, `assignedMembers`, `members`, or legacy `owner`.
  - Defaults `priority` to `50`.
  - Does not start provider execution.
- `team.plan.create`
  - Creates a queued durable task and run with `source: "plan"`.
  - Accepts `request`, `prompt`, or `description`.
  - Persists plan metadata including `reviewMode`, `mode`, `simple`, `consensus`, `reviewers`, and `maxIterations` when supplied.
  - Does not call `team.plan.generate` and does not start provider execution.
- `team.chat.queue`
  - Creates a queued durable task and run with `source: "chat"`.
  - Accepts `text`, `prompt`, or `message`.
  - Persists chat metadata including `from` and `to`.
  - Intended as the queue-first replacement path for future Team Chat dispatch.
  - Existing live `team.message.send` behavior remains unchanged until a later scheduler/dispatch phase.

Queue readers and cancellation:

- `team.task.list`
  - Preserves legacy `teamTasks`.
  - Also returns durable `queueTasks`.
- `team.task.get`
  - Returns one durable `queueTask`.
- `team.task.cancel`
  - Marks a queued durable task as `cancelled`.
  - Marks queued/waiting runs for that task as `cancelled`.
  - Does not delete queue state.
- `team.run.list`
  - Returns durable `queueRuns`.
- `team.run.get`
  - Returns one durable `queueRun`.

Existing status commands remain valid:

- `global.queue.status`
- `team.queue.status`
- `model.resources.status`

## Source Mapping

All producers write to the same `TeamQueueTask.source` field:

- Board task: `board`
- Manual task: `manual`
- Plan request: `plan`
- Chat request: `chat`
- Scheduler-created work remains reserved for `scheduler`

The allowed source set is:

```text
board | plan | chat | scheduler | manual
```

## Timeout Invariant

Producer commands create queued tasks and queued runs only. They do not create turns and do not acquire model resources.

That means producer-created queue records have:

- No `providerStartedAt`.
- No `executionTimeoutStartedAt`.
- No provider execution timeout running.
- No scheduler dispatch side effect.

The Phase 10B model resource waiting states, `waiting_for_team_slot` and `waiting_for_model`, remain pre-provider states and must not start provider execution timeout.

## Compatibility Notes

`team.task.create` still returns the legacy `teamTask` field for Board/manual callers, but it disables the legacy auto-start side effect and also returns `queueTask` plus `queueRun`.

`team.plan.generate` and `team.message.send` are intentionally not replaced in this phase. Queue-first Plan and Chat producers are exposed through `team.plan.create` and `team.chat.queue`; full dispatch replacement belongs to a later phase.
