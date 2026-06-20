import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeProviderTurn, isOpenCodeProviderEnabled } from "./agentProviders.js";
import type { TeamMember } from "./types.js";

const EXPECTED = "OPENCODE_ADAPTER_DIRECT_OK";

function execGitAsync(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    child_process.execFile("git", args, { cwd, encoding: "utf-8" }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function createTempRepo(): Promise<string> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "openvide-opencode-smoke-"));
  await execGitAsync(repo, ["init", "-b", "main"]);
  await execGitAsync(repo, ["config", "user.email", "openvide-smoke@example.invalid"]);
  await execGitAsync(repo, ["config", "user.name", "OpenVide Smoke"]);
  fs.writeFileSync(path.join(repo, "README.md"), "OpenVide OpenCode adapter smoke repo.\n");
  await execGitAsync(repo, ["add", "README.md"]);
  await execGitAsync(repo, ["commit", "-m", "Initial smoke repo"]);
  return repo;
}

async function main(): Promise<void> {
  if (!isOpenCodeProviderEnabled()) {
    throw new Error("OPENVIDE_ENABLE_OPENCODE_PROVIDER=1 is required for OpenCode adapter smoke");
  }

  const cwd = await createTempRepo();
  const member: TeamMember = {
    name: "OpenCode Smoke",
    tool: "opencode",
    role: "tester",
    sessionId: "opencode-smoke",
  };

  const result = await executeProviderTurn({
    member,
    cwd,
    prompt: "Do not edit files. Reply with exactly: OPENCODE_ADAPTER_DIRECT_OK",
    waitForCompletion: async () => ({
      status: "failed",
      responseText: "",
      errorText: "waitForCompletion should not be called for direct OpenCode execution",
    }),
  });

  const trackedChanges = await execGitAsync(cwd, ["diff", "--name-status", "--", "README.md"]);
  const payload = {
    ok: result.ok,
    status: result.status,
    provider: result.provider,
    sessionId: result.sessionId,
    responseText: result.responseText,
    error: result.error,
    errorText: result.errorText,
    diagnostics: result.diagnostics,
    cwd,
    trackedChanges,
  };
  console.log(JSON.stringify(payload, null, 2));

  if (!result.ok || result.status !== "idle") {
    throw new Error(`OpenCode provider reported failure: ${result.error ?? result.errorText ?? result.status}`);
  }
  if (!result.responseText.includes(EXPECTED)) {
    throw new Error(`OpenCode response did not include ${EXPECTED}`);
  }
  if (trackedChanges) {
    throw new Error(`OpenCode smoke repo has tracked file changes:\n${trackedChanges}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
