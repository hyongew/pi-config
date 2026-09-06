---
name: analyse-sessions
description: Read-only analysis of local Pi session history for cost and token rollups, prompt patterns, transcript search, and bounded session views.
disable-model-invocation: true
---

# Analyse Pi sessions

Use the read-only Python scripts in this skill's `scripts` directory. They read
local Pi JSONL session files and do not need network access. Session logs may
contain private prompts, code, URLs, and credentials; expose only the minimum
needed evidence and summarize raw text rather than echoing it.

## Choose the script

- `cost.py`: cost and token totals. It groups by `day` by default, uses the
  last 7 days when no date or session filter is supplied, and includes
  subagent sessions by default. Use `--by total|day|project|model|session`,
  `--show-subagents`, `--no-subagents`, or `--json`.
- `prompts.py`: extracts user prompts. It scans all matching history unless
  filtered, excludes subagents by default, limits each prompt to 2,000
  characters by default, and supports `--format md|jsonl`.
- `search.py`: searches user and assistant transcript text. Literal matching
  is the default; use `--regex`, `--in user|assistant|both`, `--context`,
  `--snippet-chars`, and opt into hidden thinking with `--include-thinking`.
  Subagents are excluded by default.
- `show_session.py`: renders one bounded transcript. It selects the newest
  matching session by default; use `--session ID` or `--latest` to be explicit.
  Tool output and assistant text are truncated by default; thinking is omitted
  unless `--include-thinking` is supplied. Use `--include-subagents-content`
  only when that content is required.

## Filters and context control

All scripts support `--since`, `--until`, `--cwd`, `--model`, `--provider`,
`--session`, `--limit`, `--min-cost`, `--min-messages`, `--errors-only`, and
`--grep` where shown by that script's help. Dates accept `YYYY-MM-DD`, ISO
datetimes, or relative values such as `7d`, `2w`, `3h`, and `30m`. Repeatable
text filters match any supplied value.

Choose the time range and filters from the user's request. Do not assume the
default 7-day range applies to scripts other than `cost.py`, and do not use a
30-day range unless requested. For a first pass, prefer aggregate output,
small `--limit` values, bounded snippets, and `--json` only when another tool
must parse the result. Expand output only when the initial result cannot answer
the question.

Date-only `--until YYYY-MM-DD` values include the entire day through 23:59:59
UTC. The scripts honor `PI_CODING_AGENT_DIR` and
`PI_CODING_AGENT_SESSION_DIR`; use those locations rather than assuming a
different session store. The provider may be `llamacpp`, `openai`,
`anthropic`, or another configured provider.

## Execution

From this skill's directory, run the relevant script with a relative path:

```bash
python scripts/cost.py --since 7d
python scripts/prompts.py --since 7d --limit 10
python scripts/search.py "search term" --since 7d --limit 10
python scripts/show_session.py --session SESSION_ID
```

Consult each script's `--help` output when a filter is unclear. Substitute
values from the user's request; never execute angle-bracket placeholders or
copy an example session ID, date, path, provider, or search term as-is.

Start with `cost.py` for usage questions, `prompts.py` for prompt-pattern
analysis, `search.py` for a known phrase or topic, and `show_session.py` after
identifying a specific session. Report the filters and defaults used so the
scope of the result is clear.
