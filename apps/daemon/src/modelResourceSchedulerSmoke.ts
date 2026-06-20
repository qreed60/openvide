import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireResource,
  listResourceStatus,
  modelResourceKey,
  releaseResource,
} from "./modelResourceScheduler.js";
import { loadTeamQueueState, saveTeamQueueState } from "./teamQueueStore.js";
import type { TeamQueueState } from "./teamQueueTypes.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-model-resources-"));
const statePath = path.join(tmpDir, "team-queue.json");
const now = new Date().toISOString();

assert.equal(modelResourceKey("codex", undefined), "codex:default");
assert.equal(modelResourceKey("codex", "  "), "codex:default");
assert.equal(modelResourceKey("codex", "gpt-5"), "codex:gpt-5");
assert.equal(modelResourceKey("opencode", "some-model"), "opencode:default");
assert.equal(modelResourceKey("openhands", "some-model"), "openhands:default");

const first = acquireResource("codex:gpt-5", { turnId: "turn_1", runId: "run_1", teamId: "team_1" }, { statePath });
assert.equal(first.status, "acquired");
assert.equal(first.resource.status, "reserved");
assert.equal(first.resource.activeTurnId, "turn_1");

const second = acquireResource("codex:gpt-5", { turnId: "turn_2", runId: "run_2", teamId: "team_1" }, { statePath });
assert.equal(second.status, "waiting");
assert.equal(second.blockedByTurnId, "turn_1");
assert.deepEqual(second.resource.queuedTurnIds, ["turn_2"]);

const independent = acquireResource("codex:gpt-4.1", { turnId: "turn_3", runId: "run_3", teamId: "team_1" }, { statePath });
assert.equal(independent.status, "acquired");
assert.equal(independent.resource.activeTurnId, "turn_3");

const released = releaseResource("codex:gpt-5", { turnId: "turn_1" }, { statePath });
assert.equal(released.status, "available");
assert.equal(released.activeTurnId, undefined);

const afterRelease = acquireResource("codex:gpt-5", { turnId: "turn_2", runId: "run_2", teamId: "team_1" }, { statePath });
assert.equal(afterRelease.status, "acquired");
assert.equal(afterRelease.resource.activeTurnId, "turn_2");

const waitingState: TeamQueueState = {
  version: 1,
  createdAt: now,
  updatedAt: now,
  tasks: {},
  runs: {},
  turns: {
    active_turn: {
      id: "active_turn",
      teamId: "team_wait",
      taskId: "task_wait",
      runId: "run_active",
      memberName: "Coder",
      provider: "codex",
      model: "gpt-5",
      resourceKey: "codex:gpt-5",
      status: "waiting_for_model",
      queuedAt: now,
    },
    waiting_turn: {
      id: "waiting_turn",
      teamId: "team_wait",
      taskId: "task_wait",
      runId: "run_waiting",
      memberName: "Reviewer",
      provider: "codex",
      model: "gpt-5",
      resourceKey: "codex:gpt-5",
      status: "queued",
      queuedAt: now,
    },
  },
  resources: {},
};
saveTeamQueueState(waitingState, { statePath, recoverStaleActive: false });
acquireResource("codex:gpt-5", { turnId: "active_turn", runId: "run_active" }, { statePath });
const waitingAcquire = acquireResource("codex:gpt-5", { turnId: "waiting_turn", runId: "run_waiting" }, { statePath });
assert.equal(waitingAcquire.status, "waiting");
const waited = loadTeamQueueState({ statePath, recoverStaleActive: false }).turns.waiting_turn;
assert.equal(waited.status, "waiting_for_model");
assert.equal(waited.providerStartedAt, undefined);
assert.equal(waited.executionTimeoutStartedAt, undefined);

const staleState: TeamQueueState = {
  version: 1,
  createdAt: now,
  updatedAt: now,
  tasks: {},
  runs: {},
  turns: {
    stale_turn: {
      id: "stale_turn",
      teamId: "team_stale",
      taskId: "task_stale",
      runId: "run_stale",
      memberName: "Coder",
      provider: "codex",
      model: "gpt-5",
      resourceKey: "codex:gpt-5",
      status: "running",
      queuedAt: now,
      startedAt: now,
      providerStartedAt: now,
      executionTimeoutStartedAt: now,
    },
  },
  resources: {
    "codex:gpt-5": {
      key: "codex:gpt-5",
      provider: "codex",
      model: "gpt-5",
      status: "running",
      activeTurnId: "stale_turn",
      queuedTurnIds: [],
      updatedAt: now,
      metadata: { owner: { turnId: "stale_turn", runId: "run_stale" } },
    },
  },
};
saveTeamQueueState(staleState, { statePath, recoverStaleActive: false });
const recovered = loadTeamQueueState({ statePath });
assert.equal(recovered.turns.stale_turn.status, "interrupted");
assert.equal(recovered.resources["codex:gpt-5"].status, "available");
assert.equal(recovered.resources["codex:gpt-5"].activeTurnId, undefined);
assert.equal(recovered.resources["codex:gpt-5"].metadata?.owner, undefined);
const reacquired = acquireResource("codex:gpt-5", { turnId: "turn_after_reload", runId: "run_after_reload" }, { statePath });
assert.equal(reacquired.status, "acquired");

const resourceStatus = listResourceStatus({ statePath });
assert.ok(resourceStatus.resources.some((resource) => resource.key === "codex:gpt-5"));

console.log(JSON.stringify({ ok: true, statePath, resourceStatus }, null, 2));
