---
name: consolidate
description: Create or update a durable Markdown handoff covering a project's premise, goals, decisions, conclusion, current state, and next steps.
disable-model-invocation: true
---

# Consolidate

Create or update a Markdown handoff document from the current conversation and
the relevant available context. Do not interview the user. Synthesize what is
already known.

## Workflow

1. Read the conversation and establish the subject, original premise, desired
   outcome, current state, constraints, reasoning, decisions, conclusion, and
   next steps. Preserve the project's terminology and explicit user choices.
2. If the subject concerns a repository, inspect only the relevant instructions,
   documentation, code, and tests needed to understand the context. If the
   repository is large and a suitable subagent is available, delegate a narrowly
   scoped, read-only exploration task. Otherwise inspect the relevant context
   directly. The main agent remains responsible for the final synthesis.
3. Separate confirmed facts and decisions from assumptions, recommendations,
   and open questions. Do not invent missing details. Record the rationale for
   important decisions and note when a newer decision supersedes an older one.
   Explicitly mark unresolved matters.
4. Write or update one overview file. Honor a path supplied by the user. The
   output target must be a Markdown file. If a supplied path is not a `.md` file,
   do not overwrite it. If no path is supplied, update an existing overview or
   established project brief; otherwise use `OVERVIEW.md` in the repository root,
   or in the current working directory when there is no repository. Read an
   existing brief before replacing it, and preserve information that the current
   conversation has not superseded.
5. Write or update the overview as a real `.md` file. Keep it factual, durable,
   and useful as the first document read by a future session. Avoid ordinary
   code and file paths that are likely to become stale unless they are necessary
   to explain the current state.
6. Validate the result before finishing:
   - exactly one Markdown overview was written or updated;
   - no implementation files or external systems were changed.

## Overview format

Use this structure, omitting a section only when it genuinely does not apply:

```markdown
# Overview: <subject>

## Problem Statement

What problem or opportunity led to this work, from the affected person's
perspective.

## Solution and Conclusion

The intended solution, the conclusion reached so far, and the outcome it must
provide.

## Context and Current State

What this is about, who or what it affects, what already exists, and where the
work currently stands.

## Goals and Original Intent

The premise, priorities, constraints, and success criteria that must survive
across sessions.

## User Stories

When useful, describe the important actors, capabilities, and benefits as a
numbered list:

1. As an <actor>, I want a <capability>, so that <benefit>.

## Decisions

Confirmed choices and their rationale, including technical direction,
boundaries, interfaces, schemas, trade-offs, or important interactions where
relevant.

## Validation and Evaluation

How the outcome should be checked: observable behaviour, tests, evidence,
evaluation criteria, or relevant prior art.

## Out of Scope

Explicitly excluded changes, behaviours, and questions.

## Assumptions and Open Questions

Unverified assumptions and unresolved decisions, including their impact and a
recommendation when one is defensible.

## Further Notes

Risks, dependencies, changed decisions, handoff details, and known next steps.
```

Keep the overview factual and durable. Future sessions should be able to read
it first and recover both the original intent and the latest conclusion
without silently broadening the scope.
