# Agent Control Phase 10B: Model Resource Scheduler

Phase 10B adds a daemon-side scheduler for provider/model resource slots. It is persistence-only in this phase: Team Chat dispatch, provider adapters, Codex/OpenCode/OpenHands execution, bridge tokens, and systemd behavior are unchanged.

## Resource Keys

- Resource keys use `provider:model`.
- Blank, whitespace, or undefined model values normalize to `provider:default`.
- `opencode` and `openhands` normalize to `opencode:default` and `openhands:default` for now. Explicit model selection for those providers is reserved for a later phase when a supported model contract exists.

## Scheduler Semantics

- `acquireResource(resourceKey, owner)` reserves one slot for the resource key.
- Default concurrency is one active owner per resource key.
- A second acquire for a reserved or running resource returns `waiting` and records the waiting turn id in `queuedTurnIds`; it does not start provider execution.
- `releaseResource(resourceKey, { turnId, runId })` frees the slot only when the supplied owner reference matches the active turn or run.
- `getResourceStatus(resourceKey)` returns one resource snapshot.
- `listResourceStatus()` returns global resource state.

## Timeout Invariant

Waiting for a model resource is not provider execution. Scheduler wait state clears `providerStartedAt` and `executionTimeoutStartedAt` on known queued turns, so provider execution timeouts only begin in the provider execution path.

## Recovery

The scheduler uses the Phase 10A queue store at `~/.openvide-daemon/team-queue.json`. Loading the store with stale recovery enabled clears active resource locks from a prior daemon process and returns stale running/reserved resources to `available` unless the resource is explicitly `disabled`.

## IPC

- `model.resources.status` returns global resource state.
- `model.resources.status` with `resourceKey` returns a single resource state.
- `model.resources.status` with `provider` and optional `model` builds the normalized resource key and returns that resource state.

`global.queue.status` and `team.queue.status` continue to include the Phase 10A resource counts.
