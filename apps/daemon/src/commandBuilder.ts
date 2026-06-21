import { escapeShellArg } from "./utils.js";
import type { Tool, BuildCommandOpts } from "./types.js";

function buildClaudeCommand(opts: BuildCommandOpts): string {
  const parts = [
    "claude",
    "-p", escapeShellArg(opts.prompt),
    "--output-format", "stream-json",
    "--verbose",
  ];

  if (opts.mode === "plan") {
    parts.push("--permission-mode", "plan", "--allow-dangerously-skip-permissions");
  } else if (opts.mode === "chat") {
    parts.push("--tools", '""', "--dangerously-skip-permissions");
  } else {
    // Default "code" mode — full tool access, auto-accept
    parts.push("--dangerously-skip-permissions");
  }

  if (opts.conversationId) {
    parts.push("--resume", escapeShellArg(opts.conversationId));
  }
  if (opts.model) {
    parts.push("--model", escapeShellArg(opts.model));
  }
  return parts.join(" ");
}

function buildCodexCommand(opts: BuildCommandOpts): string {
  let prompt = opts.prompt;
  if (opts.mode === "plan") {
    prompt = "You are in PLAN mode. Analyze the codebase and describe what changes you would make, but do NOT apply any changes.\n\n" + prompt;
  }

  if (opts.conversationId) {
    // Place exec flags before the resume subcommand for compatibility.
    const parts = [
      "codex", "exec",
      ...(opts.model ? ["--model", escapeShellArg(opts.model)] : []),
      "--json", "--sandbox", "workspace-write", "--skip-git-repo-check",
      "resume", escapeShellArg(opts.conversationId),
      "--", escapeShellArg(prompt),
    ];
    return parts.join(" ");
  }

  const parts = [
    "codex", "exec",
    ...(opts.model ? ["--model", escapeShellArg(opts.model)] : []),
    "--json", "--sandbox", "workspace-write", "--skip-git-repo-check",
    "--", escapeShellArg(prompt),
  ];
  return parts.join(" ");
}

function buildGeminiCommand(opts: BuildCommandOpts): string {
  let prompt = opts.prompt;

  // Multi-turn: prepend conversation history
  if (opts.messages && opts.messages.length > 0) {
    const history = opts.messages
      .map((m) => `${m.role}: ${m.text}`)
      .join("\n");
    if (history.length > 0) {
      prompt =
        `<previous_conversation>\n${history}\n</previous_conversation>\n\nContinue the conversation. The user says:\n${opts.prompt}`;
    }
  }

  const parts = [
    "gemini", "-p", escapeShellArg(prompt),
    "--output-format", "json", "-y",
  ];
  if (opts.model) {
    parts.push("--model", escapeShellArg(opts.model));
  }
  return parts.join(" ");
}

export function buildCommand(tool: Tool, opts: BuildCommandOpts): string {
  switch (tool) {
    case "claude":
      return buildClaudeCommand(opts);
    case "codex":
      return buildCodexCommand(opts);
    case "gemini":
      return buildGeminiCommand(opts);
  }
}
