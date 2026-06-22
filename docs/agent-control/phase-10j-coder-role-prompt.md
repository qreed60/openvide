# Phase 10J Coder Role Prompt Slice

This slice adds a canonical daemon-side Coder role prompt for delegated Team Chat and queue-backed Board execution. The prompt is provider-independent and reusable through the shared role prompt module.

## Coder Behavior

Coder is responsible for bounded implementation tasks delegated by Lead. Coder should inspect existing code before editing, stay inside the assigned repository or worktree, make minimal targeted changes, preserve existing behavior unless the task requires changing it, and run relevant validation when available and feasible.

Coder must report exact files changed and validation command results. Coder must not claim tests passed unless they actually ran. If blocked, Coder should report the blocker and stop rather than inventing success.

Coder must not perform Reviewer approval, QA sign-off, or final sign-off. Coder must not act as Lead; Coder returns implementation findings and results to Lead.

## Prompt Injection

`CODER_ROLE_PROMPT` lives in `apps/daemon/src/rolePrompts.ts`. Delegated member execution includes it when the member role normalizes to `coder`, through `buildDelegatedTaskPrompt` in `apps/daemon/src/teamOrchestrator.ts`.

Lead prompt behavior remains unchanged. Lead still owns `OV_FINAL` and `OV_DELEGATE` decisions, and Board execution still finalizes through Lead or the existing orchestration fallback path.

## AGENTS.md Handling

This slice does not generate or update `AGENTS.md`.

The current daemon Codex path sends inline prompts through Codex sessions running in the configured working directory. The local OpenCode and OpenHands adapter code does not verify a durable instruction-file contract, and this slice does not guess provider-specific instruction file names or behavior. All Coder role rules are therefore delivered inline in delegated Coder prompts.

Future work can add managed `AGENTS.md` sections for Codex only after the daemon has a clear, non-destructive utility that preserves existing project content outside managed markers.

## Deferred Work

This slice intentionally does not add role prompts for Reviewer, Scribe, Visual Reviewer, OpenCode, or OpenHands. It does not implement Plan execution, full review gates, legacy Board lifecycle behavior, queue worker scheduling changes, model routing/provider selection changes, UI changes, or provider-specific instruction-file support.
