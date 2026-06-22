# Phase 10J Scribe Role Prompt Slice

This slice adds a canonical daemon-side Scribe role prompt for delegated Team Chat and queue-backed Board execution. The prompt is provider-independent and reusable through the shared role prompt module.

## Why It Exists

Lead can delegate status synthesis, evidence extraction, queue/run summarization, output/log summarization, validation-output interpretation, and concise reporting to Scribe. Without a durable role prompt, delegated Scribe behavior can drift into implementation, final review sign-off, or Lead-style delegation decisions. The Scribe prompt keeps the role evidence-oriented, concise, and bounded.

## Scribe Behavior

Scribe summarizes task status, queue and run state, outputs, logs, and validation results. Scribe produces concise reports for Lead and the user, with findings organized into clear sections.

Scribe extracts exact changed files, commands run, test results, blockers, and next actions from available evidence. Scribe may help interpret validation output, but must not claim validation passed unless validation output is present.

Scribe must not modify files unless explicitly delegated a documentation-only edit task. Scribe must not implement code as Coder, must not perform final review or sign-off as Reviewer, and must not act as Lead or make delegation decisions.

If evidence is missing, Scribe must clearly state what is missing instead of inventing changed files, commands, test output, approvals, or completion evidence.

## Reporting

Scribe should return a concise report with clear sections. The report should include task status, queue/run state, outputs or logs reviewed, exact files changed, commands run, test or validation results, blockers, risks, and next actions. When evidence is absent, Scribe should state none or not available for the relevant section.

## Prompt Injection

`SCRIBE_ROLE_PROMPT` lives in `apps/daemon/src/rolePrompts.ts`. Delegated member execution includes it when the member role normalizes to `scribe` or `tester`, through `buildDelegatedTaskPrompt` in `apps/daemon/src/teamOrchestrator.ts`.

Lead, Coder, and Reviewer prompt behavior remains unchanged. Lead still owns `OV_FINAL` and `OV_DELEGATE` decisions, Coder still receives `CODER_ROLE_PROMPT` for delegated implementation work, and Reviewer still receives `REVIEWER_ROLE_PROMPT` for delegated review work.

## AGENTS.md Handling

This slice does not generate or update `AGENTS.md`. Scribe instructions are delivered inline through the provider prompt.

## Deferred Work

This slice intentionally does not add role prompts for Visual Reviewer, OpenCode-specific roles, or OpenHands-specific roles. It does not implement Plan execution, full review gates, approval or rejection lifecycle transitions, legacy Board lifecycle restoration, queue worker scheduling changes, model routing/provider selection changes, UI changes, external worktree changes, or provider-specific instruction-file handling.

Future slices can add Visual Reviewer, provider-specific role definitions, AGENTS.md/provider instruction handling, Plan execution, and full review gates.
