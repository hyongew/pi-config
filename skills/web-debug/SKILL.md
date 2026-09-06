---
name: web-debug
description: Debug or verify frontend behavior by using the live browser tools. Use for broken login/auth, 401/403/CORS errors, session or JWT problems, forms or buttons that do not work, blank screens, hydration issues, stale data, production-only bugs, and end-to-end verification of frontend changes.
---

# Web debugging

Use this skill when the problem concerns behavior visible in a web browser. The
browser provides runtime evidence that source inspection cannot: DOM state,
storage, console errors, actual requests, and rendered output.

## Prerequisite

The browser extension is disabled by default. If `browser-*` tools are not
available, ask the user to run `/browser on` in Pi before continuing. Use
`web-fetch` instead for static public pages.

If `web-fetch` is unavailable, use the browser tools as the fallback for
public pages when possible, then navigate to the page and inspect its rendered
content. If neither `web-fetch` nor the browser tools are available, report the
limitation and do not claim to have fetched the page.

## Workflow

1. Navigate with `browser-goto` using the relevant user-provided URL. Do not
   guess a production URL when the target is unclear.
2. Reproduce the reported behavior with `browser-fill` and
`browser-click`. Do not submit irreversible actions or modify production
   data without explicit approval.
3. Inspect `browser-console` and `browser-network`. Narrow network output with
   `urlFilter`; use `verbose: true` or `includeHeaders` only when status,
   authentication, or CORS details require them.
4. Use `browser-eval` for focused runtime checks such as DOM state, form
   validity, storage keys, or non-sensitive JWT claims. Do not dump cookies,
   tokens, or complete storage values.
5. Form a hypothesis from the observed evidence. If a code change was
   requested, make it and repeat the same flow. For diagnosis or verification
   requests, do not edit code unless the user separately asks for that.
6. Report what was observed, what was changed, and any remaining uncertainty.

Browser state persists across browser calls and turns in the current Pi
session. The persistent browser profile preserves cookies and localStorage
across Pi restarts, but the live page and browser context are torn down when
the session ends. Reuse the page while debugging; do not call `browser-close`
between steps. Close it when the session should end or when the user asks.

## Playbooks

- Auth or session: reproduce login, inspect console and auth requests, then
  check whether expected storage keys exist.
- HTTP or CORS: reproduce the action, filter network output to the failing
  route, and inspect status plus relevant request/response headers. Include
  `origin` and preflight headers when diagnosing CORS.
- Forms or buttons: inspect `document.forms` and `checkValidity()`, activate
  the control, then check console and network activity.
- Blank screen: inspect console errors, take a screenshot when visual evidence
  helps, and check the rendered body length.
- Production-only behavior: verify the current origin and session first, then
  compare the same flow in development. Treat the persistent profile as
  sensitive.
- Frontend verification: reload the changed page, exercise the behavior, make
  a focused assertion with `browser-eval`, and take a screenshot for visual
  claims.

## Pitfalls and safety

- A fetch whose body is not consumed may appear as `ERR_ABORTED`; consume the
  body before judging the network result.
- Return primitive DOM values such as `textContent`, `value`, `checked`, or
  `outerHTML`, not DOM nodes.
- `button[type=submit]` matches an HTML attribute, not the default DOM
  property. Prefer a semantic selector such as `text=Submit` or a role
  selector.
- `browser-console` and `browser-network` clear their full buffers by default;
  use `clear: false` when preserving later evidence matters.
- `browser-eval` needs an expression. Wrap multi-statement logic in an IIFE.
- Treat cookies, storage values, authorization headers, and tokens as secrets;
  do not include their raw values in the final response.

## Use another tool instead

Use `web-fetch` for static public content, source tools for source-only
questions, and a script for many URLs. The browser is for interactive runtime
debugging.
