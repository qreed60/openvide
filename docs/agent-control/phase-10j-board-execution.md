# Phase 10J Board Execution Slice

This document covers the fast deployable Phase 10J slice only: queue-backed Board task execution through the existing queue worker, Team Chat orchestrator, and provider/model resource scheduler.

## Scope

- Board queue tasks with `source: "board"` are dispatchable by `dispatchTeamQueueOnce`.
- The queue worker, manual `team.queue.dispatch_once`, and worker `tick_once` all use the same dispatcher path.
- Plan execution remains non-executable in this slice.
- Full review gate behavior is not implemented in this slice.
- Legacy TODO/DONE/REVIEW/APPROVED Board lifecycle labels are not restored.

## Dispatch Routing

Board dispatch resolves the team Lead/coordinator as the first queue member. That keeps Board work on the same Team Chat orchestration path as queued Chat and lets the orchestrator decide whether to run directly or delegate.

The Board execution prompt includes:

- Board title.
- Board description.
- Assigned-member intent, when present.
- Priority.
- Team id, team name, working directory, and roster.

When `assignedMembers` is empty, the prompt tells the Lead to decide and run the task directly when appropriate. When assigned members are present, the prompt tells the Lead to use those assignments as intent for orchestration/delegation.

## Result Persistence

Board execution results are persisted on both the queue task and queue run metadata:

- `queuedBoardResult.assistantText`
- `queuedBoardResult.route`
- `queuedBoardResult.provider`
- `queuedBoardResult.model`
- `queuedBoardResult.memberName`
- `queuedBoardResult.finalStatus`
- `queuedBoardResult.diagnostics`
- `assistantText`, `route`, `provider`, `model`, `memberName`, `finalStatus`, and `noOutputDiagnostic`

The Board projection also stores compact display fields under `metadata.board`:

- `resultSummary`
- `resultStatus`
- `resultRoute`
- `resultMemberName`
- `resultProvider`
- `resultModel`
- `resultDiagnostics`

No Board item is marked completed unless the orchestrator returns assistant output and a non-failed/non-blocked final status. No-output, failed, and blocked outcomes are terminalized with diagnostics instead of being treated as success.

## Execution Status Projection

Queue-backed Board `executionStatus` is derived from queue task/run state:

- `queued`
- `waiting_for_team_slot`
- `waiting_for_model`
- `running`
- `completed`
- `failed`
- `cancelled`
- `interrupted`
- `blocked`

Blocked Board metadata is preserved as `blocked` for Board projection. Review status remains separate and is only changed by explicit review-status updates.

## Timeout Invariant

The dispatcher still sets `providerStartedAt` and `executionTimeoutStartedAt` only after a provider/model resource is acquired and the member turn is about to start. Queue time and waiting-for-resource/team-slot time do not count as provider execution time.

## Validation

The new `teamBoardExecutionSmoke` covers:

- Board task dispatch through Team Chat orchestration.
- Prompt construction from Board title, description, assigned members, priority, and team context.
- Result metadata persistence on task/run and Board projection.
- No-output failure diagnostics.
- Waiting-for-model state without provider timeout timestamps.

Existing worker smoke also covers worker `tick_once` dispatch of Board tasks.
