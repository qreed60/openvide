import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-chat-queue-idempotency-"));
process.env.HOME = tmpHome;

const { routeCommand } = await import("./ipc.js");
const { loadTeamQueueState, getTeamQueueStatePath } = await import("./teamQueueStore.js");

const first = await routeCommand({
  cmd: "team.chat.queue",
  teamId: "team_ipc_idempotency",
  text: "Ask the team once",
  to: "Lead",
  from: "user",
  clientMessageId: "client-message-ipc-1",
});
assert.equal(first.ok, true);
assert.equal(first.reused, false);
assert.equal(first.idempotent, false);
assert.equal(first.queueTask?.metadata?.clientMessageId, "client-message-ipc-1");
assert.equal(first.queueRun?.metadata?.clientMessageId, "client-message-ipc-1");

const repeated = await routeCommand({
  cmd: "team.chat.queue",
  teamId: "team_ipc_idempotency",
  text: "Ask the team once",
  to: "Lead",
  from: "user",
  clientMessageId: "client-message-ipc-1",
});
assert.equal(repeated.ok, true);
assert.equal(repeated.reused, true);
assert.equal(repeated.idempotent, true);
assert.equal(repeated.queueTask?.id, first.queueTask?.id);
assert.equal(repeated.queueRun?.id, first.queueRun?.id);

const separate = await routeCommand({
  cmd: "team.chat.queue",
  teamId: "team_ipc_idempotency",
  text: "Ask the team once",
  to: "Lead",
  from: "user",
  clientMessageId: "client-message-ipc-2",
});
assert.equal(separate.ok, true);
assert.equal(separate.reused, false);
assert.notEqual(separate.queueTask?.id, first.queueTask?.id);
assert.notEqual(separate.queueRun?.id, first.queueRun?.id);

const state = loadTeamQueueState({ recoverStaleActive: false });
const tasks = Object.values(state.tasks).filter((task) => task.teamId === "team_ipc_idempotency");
const runs = Object.values(state.runs).filter((run) => run.teamId === "team_ipc_idempotency");
assert.equal(tasks.length, 2);
assert.equal(runs.length, 2);

console.log(JSON.stringify({
  ok: true,
  statePath: getTeamQueueStatePath(),
  firstTaskId: first.queueTask?.id,
  repeatedTaskId: repeated.queueTask?.id,
  separateTaskId: separate.queueTask?.id,
}, null, 2));
