# Phase 10J Lead Role Prompt Slice

This slice adds a canonical daemon-side Lead role prompt so queued Chat and queue-backed Board execution use the same Lead behavior rules instead of embedding ad hoc role instructions in each prompt builder.

## What Lead May Do Directly

Lead may answer directly when the task is clearly read-only, administrative, answer-only, or already has enough evidence to provide a concise final result. For Board tasks, Lead should prefer a concise execution result that reports only real work performed, validated outcomes, blockers, or no-output conditions.

Lead must not claim files changed, tests ran, providers executed, or work completed unless tool or provider output supports that claim.

## When Lead Should Delegate

Lead should delegate coding, implementation, file-writing, and repository modification work to Coder unless the task is clearly read-only, administrative, or answer-only. Lead should delegate validation, QA, review, or sign-off work to Reviewer or Scribe as appropriate.

Lead must not simulate Coder, Reviewer, Scribe, Visual Reviewer, OpenHands, or OpenCode. When another member should act, Lead emits `OV_DELEGATE` and the daemon invokes that member.

## Output Contract

Every Lead response must end with exactly one supported contract:

- `OV_FINAL` for a direct answer, final Board result, clear blocker, or concise failure report.
- `OV_DELEGATE` when another member must act.

If Lead is blocked, it should report the blocker clearly and concisely inside `OV_FINAL`.

## Deferred Work

This slice intentionally does not add role prompts for Coder, Reviewer, Scribe, Visual Reviewer, OpenCode, or OpenHands. It does not generate `AGENTS.md`, add provider-specific instruction files, implement Plan execution, restore legacy Board lifecycle behavior, add full review gates, alter queue worker scheduling, change model routing/provider selection, or change UI.

Future role slices can add canonical prompts for Coder, Reviewer, Scribe, Visual Reviewer, OpenCode, and OpenHands using the same reusable prompt-template pattern.
