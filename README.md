# Pi Extensions and Skills

Invocation labels:

- **User** — requires a direct user command, shortcut, or action.
- **Model** — selected or called by the model when relevant.
- **Both** — can be called by both the user and model.
- **Automatic** — runs through Pi lifecycle or tool-event hooks.

## Extensions

| Extension     | Called by | Purpose                                                                                                              |
|---------------|-----------|----------------------------------------------------------------------------------------------------------------------|
| bash-guard    | User      | Guards high-risk commands with approval.                                                                             |
| ask-question  | Model     | Asks one interactive clarification or preference question with text, single-select, or multi-select input.           |
| claude-ctrl-c | Automatic | Mimics the Ctrl+C behaviour of Claude Code.                                                                          |
| qwen-think    | User      | Prefixes main-session user prompts with the selected Qwen thinking tag.                                              |
| subagents     | Both      | Runs single-purposed subagents with the model specified in the subagent's .md file, or the served llama.cpp model.   |
| safe-bash     | Model     | Runs restricted read-only shell commands for worker subagents. Packaged with the `subagents` extension.              |
| browser       | User      | Provides persistent Chromium navigation, page evaluation, form actions, screenshots, console and network inspection. |
| web-search    | Model     | Searches the local SearXNG instance and returns compact, bounded web results.                                        |
| web-fetch     | Model     | Fetches HTML, PDFs, and text, then extracts readable Markdown.                                                       |


## Skills

| Skill              | Called by  | Purpose                                                                                                             |
|--------------------|------------|---------------------------------------------------------------------------------------------------------------------|
| analyse-sessions   | User       | Retrieves local Pi session history for costs, prompts, transcript searches, and bounded session views.              |
| pdf-reader         | Both       | Reads and analyzes PDFs.                                                                                            |
| web-debug          | Both       | Guides live frontend debugging and verification using browser runtime, storage, console, network, and DOM evidence. |
| youtube-transcript | Both       | Extracts YouTube captions or researches YouTube topics using local transcripts and selective web search.            |
| grill-me           | User       | Relentlessly interviews the user about any objective, idea, concept, decision, project, or situation.               |
| consolidate        | User       | Consolidates context into a durable Markdown overview preserving intent, reasoning, decisions, and conclusions.     |
| plan-project       | User       | Creates or updates an actionable project plan with outcomes, phases, and development checklists.                    |
| implement          | User       | Implements work from a plan or specification with incremental validation, plan progress, and code review.           |

## Credits

These extensions and skills are sourced from [amosblomqvist](https://github.com/amosblomqvist/pi-config) and [mattpocock](https://github.com/mattpocock/skills), with tweaks for my own setup and use case.
