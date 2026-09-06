---
name: plan-project
description: Create or update an actionable software project plan from the current conversation or an overview file. Adapt between a single-phase plan for small projects and a multi-phase plan for large projects, with an outcome or MVP and a development checklist for every phase.
disable-model-invocation: true
---

# Plan Project

Create a practical, reviewable software project plan. The plan is a planning
artifact, not an implementation task list detached from product outcomes.

## Establish the planning basis

1. Read the current conversation and preserve the user's terminology,
   priorities, constraints, and explicit decisions.
2. If the user explicitly points to an overview file, read that file. Otherwise,
   read `OVERVIEW.md` from the project root or current working directory if it
   exists. Do not search broadly for alternative overview files unless asked.
3. If `PLAN.md` exists, read it as the baseline. Treat the result as an update
   when an existing plan is present; preserve completed items, status notes, and
   valid decisions unless newer context supersedes them.
4. Separate confirmed requirements from assumptions, recommendations, and open
   questions. Do not invent technologies, features, users, or constraints.
5. If the available context is insufficient to make a useful plan, ask only the
   smallest set of questions that materially changes the plan. Otherwise proceed
   and label assumptions clearly.

## Choose the plan shape

Classify the project from its apparent scope, number of distinct capabilities,
integration or migration risk, and architectural complexity.

- For a small project, create exactly one phase containing the complete plan.
- For a large project, divide the work into dependency-ordered phases. Use as
  many phases as the scope needs; do not manufacture phases merely to make the
  plan look detailed.
- Do not include dates, durations, estimates, or calendar timelines unless the
  user explicitly requests them.

Phases may cover discovery, architecture, shared foundation, vertical product
slices, integrations, hardening, and release readiness. Adapt these to the
project. Architecture, testing, documentation, deployment, observability,
security, migrations, and other enabling work belong in the plan when they are
required, even when they are not user-facing features.

## Define each phase

Every phase must include:

- **Outcome / MVP:** the smallest meaningful result that proves the phase is
  complete. For foundation phases, this can be a runnable, validated technical
  baseline rather than a customer-facing feature.
- **Checklist:** concrete, verb-first tasks. Include product work and the
  supporting engineering work needed to make the outcome usable and verifiable.
- **Dependencies:** prerequisites, decisions, external systems, data, or other
  phases that must be available.
- **Exit criteria:** observable checks that demonstrate the outcome is complete.

Prefer vertical slices when practical. Break checklist items down far enough to
be actionable, but do not turn the plan into implementation-level code steps.
Include validation tasks such as tests, documentation, migration checks,
security review, observability, deployment, rollback, or user acceptance when
they apply.

## Produce the plan

Display the complete proposed plan in the response using this structure, omitting
sections only when they genuinely do not apply:

```markdown
# Project Plan

## Planning Basis

- Source:
- Goal:
- Users or stakeholders:
- Existing state:
- Constraints:
- Assumptions:

## Phase 1 — <name>

### Outcome / MVP

<meaningful result>

### Checklist

- [ ] <actionable task>

### Dependencies

- <dependency>

### Exit Criteria

- <observable criterion>

## Phase 2 — <name>

...

## Risks and Open Questions

- <item>

## Out of Scope

- <item>

## Immediate Next Actions

- <item>
```

When updating an existing plan, keep the plan's useful structure and completed
status. Reflect changed or removed scope explicitly instead of silently dropping
it. If the update introduces meaningful changes, briefly summarize them before
the proposed plan in the response.

## Saving the plan

Do not write a file merely because `PLAN.md` exists. Always display the proposed
plan first and offer to save it as `PLAN.md`. Save only after the user approves,
using the project root when it is known and otherwise the current working
directory. When updating an existing `PLAN.md`, preserve valid content and
completion status that the approved revision does not supersede.

Writing the plan must not modify source code, configuration, or other project
files.
