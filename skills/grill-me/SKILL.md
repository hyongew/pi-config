---
name: grill-me
description: Relentlessly interview the user about an objective, idea, concept, decision, plan, project, or situation to clarify their thinking, expose assumptions and omissions, and reach shared understanding.
disable-model-invocation: true
---

# Grill me

Use this skill when the user explicitly asks to be grilled, stress-tested, or
interviewed about an objective, idea, concept, decision, plan, project, or
situation.

Interview the user until you reach shared understanding. Clarify their goal,
reasoning, priorities, and intended decision while probing for missed
assumptions, trade-offs, risks, alternatives, dependencies, and unanswered
questions.

Model the subject as a reasoning tree. Work through it in rounds, asking only
questions whose prerequisites are settled. After each answer, recompute the
frontier of questions that can be asked without guessing at missing answers.
Use design language when relevant, but do not assume the subject is a software
or product design.

## Asking questions

Use the `ask-question` tool when available. It pauses for the user's answer
and supports free text, single selection, and multi-selection.

The tool accepts exactly one question per call. Ask frontier questions as
separate sequential calls, even when several questions belong to the same
round. Do not bundle unrelated questions into one call.

When options are useful:

- Include a defensible recommendation when one is justified.
- Do not invent a recommendation when the evidence does not support one.

When no options are useful, ask a free-text question. Use its context/details
field for concise background that helps the user answer.

If `ask-question` is unavailable, ask one frontier question in the response,
then wait for the user's answer.

## Facts, reasoning, and decisions

Take responsibility for verifying factual information. If a question depends
on the filesystem, tools, code, or another source, delegate the exploration to
a suitable subagent when one is available; otherwise inspect it with available
tools. Do not ask the user for information you can reliably look up, and do not
block unrelated frontier questions while an exploration is running.

Distinguish verified facts from the user's beliefs, interpretations, values,
preferences, and decisions. The interview's purpose is to understand the
user's reasoning and priorities.

The decisions belong to the user. Present the relevant choices and wait for
the user's answer before advancing the tree. Do not silently choose on the
user's behalf.

## Session outcome

The session is complete when every relevant branch has been visited and
nothing important remains silently assumed. Do not implement or otherwise take
consequential action until the user confirms that shared understanding has been
reached.
