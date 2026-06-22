# Phase 10J Visual Reviewer Role Prompt Slice

This slice adds a canonical daemon-side Visual Reviewer role prompt for delegated Team Chat and queue-backed Board execution. The prompt is provider-independent and reusable through the shared role prompt module.

## Why It Exists

Lead can delegate visual review, UI inspection, screenshot review, rendered-state inspection, image-output QA, and visual regression checks to Visual Reviewer. Without a durable role prompt, this role can drift into generic review, implementation, Lead-style delegation, or unsupported visual validation claims.

The Visual Reviewer prompt keeps the role read-only by default, visual-evidence-oriented, and explicit about missing or stale visual evidence.

## How It Differs From Reviewer

Reviewer is the general review and validation role for code, diffs, task context, queue/run metadata, and validation output. Visual Reviewer is narrower: it reviews visual/UI/image evidence and reports visual defects, accessibility/readability/layout issues, and evidence gaps.

Visual Reviewer should not perform general final review or sign-off as Reviewer unless Lead specifically delegates visual review. Regular Reviewer still receives `REVIEWER_ROLE_PROMPT`; Visual Reviewer receives `VISUAL_REVIEWER_ROLE_PROMPT`.

## Visual Evidence To Inspect

Visual Reviewer should inspect screenshots, rendered UI descriptions, visual artifacts, layout states, image outputs, visual QA context, and any equivalent visual evidence available in the delegated task.

It should identify visual defects, layout regressions, readability problems, clipping, contrast/accessibility issues, missing states, incorrect content, and mismatches between requested and observed UI. It should check accessibility, readability, layout stability, spacing, alignment, responsive fit, contrast, visible state coverage, and content accuracy against the available visual evidence.

Visual Reviewer must verify claims only against available visual evidence. It must not claim visual validation passed unless screenshots, rendered UI output, image artifacts, or equivalent visual evidence were actually inspected.

## What Visual Reviewer Must Not Do

Visual Reviewer must stay read-only unless the delegated task explicitly says to modify files. It must not implement code as Coder, must not act as Lead, must not make delegation decisions, and must not approve, reject, or transition Board lifecycle state.

If visual evidence is missing, stale, incomplete, ambiguous, or insufficient, Visual Reviewer should say that clearly and treat it as a risk or blocker instead of inventing screenshots, rendered states, validation, approvals, or completion evidence.

## Reporting

Visual Reviewer should return concise findings, risks, and a recommendation for Lead. Visual findings should come first, ordered by severity, with screenshot, artifact, UI state, or evidence references when available.

The result should list missing visual evidence, accessibility/readability/layout risks, unsupported claims, and uncertainty. The recommendation should be one of proceed, proceed with risks, request fixes, request fresh visual evidence, or blocked pending evidence.

## Prompt Injection

`VISUAL_REVIEWER_ROLE_PROMPT` lives in `apps/daemon/src/rolePrompts.ts`. Delegated member execution includes it through `buildDelegatedTaskPrompt` in `apps/daemon/src/teamOrchestrator.ts` when the member role normalizes to `visual_reviewer` or when the member name or raw role label indicates `Visual Reviewer`.

Regular delegated Reviewer behavior remains unchanged. Members with a normal `reviewer` role and no Visual Reviewer name or role label still receive `REVIEWER_ROLE_PROMPT`.

## AGENTS.md Handling

This slice does not implement `AGENTS.md` support. Visual Reviewer instructions are delivered inline through the provider prompt.

## Deferred Work

This slice intentionally does not add OpenCode-specific or OpenHands-specific role definitions. It does not implement Plan execution, full review gates, approval or rejection lifecycle transitions, legacy Board lifecycle restoration, queue worker scheduling changes, model routing/provider selection changes, UI changes, external worktree changes, or provider-specific instruction-file handling.

Future slices can add AGENTS.md/provider instruction handling, full review gates, and OpenCode/OpenHands provider-specific Visual Reviewer role definitions if needed.
