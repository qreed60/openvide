# Phase 10J Reviewer Role Prompt Slice

This slice adds a canonical daemon-side Reviewer role prompt for delegated Team Chat and queue-backed Board execution. The prompt is provider-independent and reusable through the shared role prompt module.

## Why It Exists

Lead can delegate review, validation, QA, and sign-off-oriented work to Reviewer. Without a durable role prompt, delegated Reviewer behavior can drift into implementation, Lead-style coordination, or unsupported validation claims. The Reviewer prompt makes the delegated role deterministic, evidence-oriented, and read-only by default.

## Reviewer Behavior

Reviewer is read-only by default. Reviewer must not edit files unless the delegated task explicitly says to modify files. The default behavior is to inspect and report, not implement.

Reviewer should inspect relevant code, diffs, task context, queue or run metadata, and validation output when available. Reviewer should identify correctness issues, regressions, missing tests, unsafe assumptions, unsupported claims, and scope drift.

Reviewer must not claim validation passed unless validation output is present. If validation output, diffs, run metadata, or other necessary context is missing, Reviewer should report that as missing evidence, a risk, or a blocker.

Reviewer must not perform implementation as Coder and must not act as Lead. Reviewer returns findings and a recommendation to Lead.

## Reporting

Reviewer should return a concise review result. Findings should come first, ordered by severity, with file or evidence references when available. The result should list risks, missing tests, missing validation output, unsupported claims, and a recommendation for Lead, such as proceed, proceed with risks, request fixes, or blocked pending evidence.

## Prompt Injection

`REVIEWER_ROLE_PROMPT` lives in `apps/daemon/src/rolePrompts.ts`. Delegated member execution includes it when the member role normalizes to `reviewer`, through `buildDelegatedTaskPrompt` in `apps/daemon/src/teamOrchestrator.ts`.

Lead and Coder prompt behavior remains unchanged. Lead still owns `OV_FINAL` and `OV_DELEGATE` decisions, and Coder still receives `CODER_ROLE_PROMPT` for delegated implementation work.

## AGENTS.md Handling

This slice does not generate or update `AGENTS.md`. Reviewer instructions are delivered inline through the provider prompt.

## Deferred Work

This slice intentionally does not add role prompts for Scribe, Visual Reviewer, OpenCode-specific roles, or OpenHands-specific roles. It does not implement Plan execution, full review gates, approval or rejection lifecycle transitions, legacy Board lifecycle restoration, queue worker scheduling changes, model routing/provider selection changes, UI changes, external worktree changes, or provider-specific instruction-file handling.

Future slices can add Scribe, Visual Reviewer, AGENTS.md/provider instruction handling, and full review gates.
