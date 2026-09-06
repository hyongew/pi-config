---
name: implement
description: Implement user-requested code or configuration work from a plan or specification, preserving unrelated changes and validating the result with relevant checks and review.
disable-model-invocation: true
---

# Implement

Implement the work requested by the user with a plan or specification when one
exists, or with a sufficiently clear direct task when one does not. Keep the
scope limited to the request and the repository's established conventions.

## Continue to completion

Implement the user's requested outcome fully. If the user does not define a
stopping point, continue until that outcome is implemented and validated.

Act autonomously. Do not stop for routine clarification or during tool-call
failures. Make reasonable in-scope assumptions, diagnose failures, correct
the cause, and retry or use an authorized alternative when available.

Do not bypass permissions, weaken safety controls, or invent workarounds. Ask
the user only when authorization or a required user action is missing,
or no authorized path remains. Report such blockers clearly. As much as
possible, make decisions based on the information you already have.

## Establish the basis

1. Read repository instructions and inspect the current working tree before
   editing. Preserve unrelated user changes; do not reset, discard, or overwrite
   them.
2. Read the plan or specification named by the user. If none is named, read
   `PLAN.md` and `OVERVIEW.md` if they exist. Treat the plan as scope and the
   overview as durable context; neither authorizes silently broadening the
   request.
3. Confirm the outcome, constraints, relevant existing code, available
   validation commands, and repository commit policy. Ask only when a missing
   decision materially blocks safe progress.

## Implement in slices

- Prefer vertical slices that deliver observable behavior.
- Use test-driven development when behavior can be tested and the repository's
  conventions support it: write a failing test, make the smallest change that
  passes it, then refactor only after the tests are green. Do not force TDD for
  documentation, configuration, or work where it provides no useful signal.
- After each slice, run focused tests and relevant typechecking when those
  checks exist. Run the full test suite after each logical feature and before
  finishing when a full suite exists and it is practical. If the suite is
  unusually expensive, use sensible checkpoints; if checks are unavailable or
  cannot run, report that explicitly.
- Distinguish regressions from pre-existing failures. Fix failures caused by
  the requested work, but do not repair unrelated baseline failures or expand
  the task without user approval.
- Delegate narrowly scoped exploration or implementation tasks only when the
  runtime supports delegation and it is useful. The main agent remains
  responsible for scope, decisions, integration, and verification.

If the user explicitly names a writable plan as part of the task, update it
minimally after completing work covered by that plan: mark completed items and
add only concise implementation notes, new dependencies, or discovered
follow-up work. Preserve its structure, decisions, and existing completion
status. Do not rewrite it, modify an external or read-only plan, or silently
broaden the plan; surface material scope changes to the user.

## Commits

Commit only when the user requests commits or repository instructions require
them. When committing:

- review the working-tree status and diff first;
- stage only the requested changes using explicit paths;
- exclude unrelated user changes, generated handoffs, secrets, and unrelated
  generated files;
- do not rewrite history or discard existing commits; and
- commit a logical slice only after its relevant checks pass, unless the user
  explicitly accepts known failures.

## Review and finish

When a reviewer agent is available and the runtime supports it, provide it the
changed paths or diff and the relevant plan context. It must remain read-only
and independent. Triage its concrete findings and fix them in the main session.
A worker may carry out a clearly bounded corrective change when useful, but the
main agent must verify the result and rerun the relevant review and checks.

If no reviewer agent is available, review the diff yourself for correctness,
edge cases, tests, regressions, unnecessary scope, and documentation gaps.

Before finishing:

- run relevant typechecks and tests that exist and are practical, including
  the full suite when appropriate;
- confirm any explicitly named plan reflects the implementation without a
  rewrite;
- if commits were requested or required, commit only validated requested
  changes; otherwise leave commits untouched; and
- report what changed, what was verified, any unresolved issues, and a commit
  identifier only when a commit was actually created.
