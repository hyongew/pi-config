/**
 * Browser extension — Playwright-driven headless Chromium pi can drive.
 *
 * Exposes a small set of tools the LLM can call to debug a live web app:
 *   - browser-goto         navigate
 *   - browser-eval         run JS in the page (read localStorage, decode JWTs,
 *                          inspect the DOM, etc.)
 *   - browser-console      drain buffered console + pageerror entries
 *   - browser-network      drain buffered network requests (status, headers)
 *   - browser-fill         fill an input
 *   - browser-click        click an element
 *   - browser-screenshot   write a PNG to /tmp and return the path
 *   - browser-close        close the persistent browser
 *
 * Plus a /browser command for toggling and status from the TUI.
 *
 * Browser state is a singleton kept alive across tool calls so login
 * sessions, cookies, and localStorage survive between turns. It's torn
 * down on `session_shutdown`.
 *
 * Setup:
 *   cd ~/.pi/agent
 *   npm install
 *   npx playwright-core install chromium
 *   # then /reload in pi (or restart)
 *
 * Tweaks:
 *   PI_BROWSER_HEADFUL=1   launch a visible window (useful when debugging the extension itself).
 *   PI_BROWSER_PROFILE     override the user-data dir (default ~/.pi/agent/extensions/browser/.profile)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  chromium,
  type BrowserContext,
  type Page,
  type ConsoleMessage,
  type Request,
} from "playwright-core";

type ConsoleEntry = {
  ts: number;
  type: string;
  text: string;
  location?: string;
};

type NetEntry = {
  ts: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  failure?: string;
};

const MAX_BUF = 1000;
const DEFAULT_READ_LIMIT = 100;
const BROWSER_TOOL_NAMES = [
  "browser-goto",
  "browser-eval",
  "browser-console",
  "browser-network",
  "browser-fill",
  "browser-click",
  "browser-screenshot",
  "browser-close",
];
const KEEP_HEADERS = new Set([
  "authorization",
  "apikey",
  "content-type",
  "x-client-info",
  "accept-profile",
  "content-profile",
  "prefer",
  "location",
  "www-authenticate",
  "retry-after",
]);
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "access-token",
  "id-token",
  "refresh-token",
]);
const SENSITIVE_QUERY_KEYS = /(?:auth|api[-_]?key|token|secret|password|passwd|session|cookie)/i;

function isSensitiveHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return SENSITIVE_HEADERS.has(normalized) || SENSITIVE_QUERY_KEYS.test(normalized);
}

function redactHeaderValue(name: string, value: string): string {
  return isSensitiveHeader(name) ? "[REDACTED]" : value;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "[REDACTED]";
      url.password = "[REDACTED]";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = redactHeaderValue(k, v);
  return out;
}

function pushBounded<T>(buf: T[], entry: T): void {
  buf.push(entry);
  if (buf.length > MAX_BUF) buf.splice(0, buf.length - MAX_BUF);
}

function normalizeReadLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_READ_LIMIT;
  return Math.max(0, Math.min(MAX_BUF, Math.trunc(value as number)));
}

function takeLast<T>(items: T[], limit: number): T[] {
  return limit === 0 ? [] : items.slice(-limit);
}

function filterHeaders(
  h: Record<string, string>,
  allow: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (allow.has(k.toLowerCase())) out[k] = redactHeaderValue(k, v);
  }
  return out;
}

/**
 * Serialize all tool executions against the single shared Page.
 *
 * Playwright's Page is not concurrent-safe: if pi fires multiple browser-*
 * tools in one block (which it does by default for independent calls), two
 * `fill`s will race into the same field, and a `goto` followed by an `eval`
 * in the same batch will hit "Execution context was destroyed" because the
 * eval lands during the navigation teardown.
 *
 * Wrapping every execute body in this queue costs the latency we should be
 * paying anyway and removes the entire class of race from the LLM's mental
 * model.
 */
let opQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = opQueue.then(fn, fn);
  opQueue = next.catch(() => {});
  return next;
}

export default function browserExtension(pi: ExtensionAPI) {
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const consoleBuf: ConsoleEntry[] = [];
  const netBuf: NetEntry[] = [];
  const screenshotDirs = new Set<string>();

  const profileDir =
    process.env.PI_BROWSER_PROFILE ??
    join(
      process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
      "extensions",
      "browser",
      ".profile",
    );
  const headless = !process.env.PI_BROWSER_HEADFUL;

  async function ensurePage(): Promise<Page> {
    if (page && !page.isClosed()) return page;

    if (!context) {
      try {
        context = await chromium.launchPersistentContext(profileDir, {
          headless,
          viewport: { width: 1280, height: 800 },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Chromium could not start. From the pi agent directory, run 'npm install' and then 'npx playwright-core install chromium'. ${message}`,
        );
      }
    }

    try {
      page = context.pages()[0] ?? (await context.newPage());
    } catch {
      await context.close().catch(() => {});
      context = null;
      return ensurePage();
    }

    page.on("console", (msg: ConsoleMessage) => {
      const loc = msg.location();
      pushBounded(consoleBuf, {
        ts: Date.now(),
        type: msg.type(),
        text: msg.text(),
        location: loc?.url ? `${loc.url}:${loc.lineNumber}` : undefined,
      });
    });
    page.on("pageerror", (err) => {
      pushBounded(consoleBuf, {
        ts: Date.now(),
        type: "pageerror",
        text: `${err.name}: ${err.message}`,
      });
    });
    page.on("requestfinished", async (req: Request) => {
      try {
        const res = await req.response();
        pushBounded(netBuf, {
          ts: Date.now(),
          method: req.method(),
          url: redactUrl(req.url()),
          status: res?.status(),
          statusText: res?.statusText(),
          resourceType: req.resourceType(),
          // Capture headers only after redacting credentials. Keep the
          // in-memory buffer safe even if another renderer is added later.
          requestHeaders: redactHeaders(req.headers()),
          responseHeaders: res ? redactHeaders(res.headers()) : undefined,
        });
      } catch {
        // request may have been aborted; ignore
      }
    });
    page.on("requestfailed", (req: Request) => {
      pushBounded(netBuf, {
        ts: Date.now(),
        method: req.method(),
        url: redactUrl(req.url()),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText,
      });
    });

    return page;
  }

  async function teardown(): Promise<void> {
    try {
      await context?.close();
    } catch {
      // best-effort
    }
    context = null;
    page = null;
    for (const dir of screenshotDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the OS temp cleaner can reclaim it later.
      }
    }
    screenshotDirs.clear();
  }

  // Default-off gate. The browser tools collectively cost ~800 system-prompt
  // tokens (snippets + guidelines), but are needed in a small minority of
  // sessions. We keep all 8 tools registered so they appear in
  // pi.getAllTools() and command discovery stays normal, but we strip them
  // from the active set so their promptSnippet / promptGuidelines drop out
  // of the system prompt. They become callable again when /browser
  // toggles them on.
  let enabled = false;

  function setEnabled(on: boolean, ctx: ExtensionContext): void {
    const active = new Set(pi.getActiveTools());
    if (on) {
      for (const name of BROWSER_TOOL_NAMES) active.add(name);
    } else {
      for (const name of BROWSER_TOOL_NAMES) active.delete(name);
    }
    pi.setActiveTools(Array.from(active));
    enabled = on;
    ctx.ui.setStatus(
      "browser",
      enabled ? ctx.ui.theme.fg("muted", "🌎 browser") : undefined,
    );
  }

  async function enable(ctx: ExtensionContext): Promise<void> {
    setEnabled(true, ctx);
  }

  async function disable(ctx: ExtensionContext): Promise<void> {
    setEnabled(false, ctx);
    await serialize(teardown);
  }

  // Initialize the gate on session_start. We can't call setActiveTools
  // during the factory — the extension runtime isn't initialized yet and
  // pi throws "Action methods cannot be called during extension loading".
  // session_start fires after the runtime is up and after the registerTool
  // calls below have settled, so it's the first safe point to flip the
  // browser tools out of the active set.
  //
  pi.on("session_start", async (_event, ctx) => {
    setEnabled(false, ctx);
  });

  pi.on("session_shutdown", async () => {
    await serialize(teardown);
  });

  pi.registerTool({
    name: "browser-goto",
    label: "Browser Goto",
    description:
      "Navigate the persistent headless Chromium to a URL. Returns final URL and HTTP status. Cookies + localStorage persist across calls.",
    promptSnippet:
      "Open a URL in a persistent headless browser to inspect a live web app's DOM, storage, network, and console — instead of asking the user to copy from devtools",
    promptGuidelines: [
      "When debugging a frontend issue (broken auth, failed requests, missing tokens, JS errors, form not working, blank screen), prefer driving the live app with browser-goto + browser-eval + browser-console + browser-network instead of asking the user to copy-paste from devtools.",
      "When the user reports 'works in browser, fails here' or 'I tried X and it didn't work', use browser-goto to reproduce the exact flow yourself before forming a hypothesis from source alone.",
      "After making a frontend change, use browser-goto plus browser-click / browser-fill to actually exercise the fix end-to-end before declaring it done — don't rely on the user to verify.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
      waitUntil: Type.Optional(
        Type.Union([
          Type.Literal("load"),
          Type.Literal("domcontentloaded"),
          Type.Literal("networkidle"),
          Type.Literal("commit"),
        ]),
      ),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        const resp = await p.goto(params.url, {
          waitUntil: params.waitUntil ?? "domcontentloaded",
          timeout: params.timeoutMs ?? 30_000,
        });
        const status = resp?.status();
        return {
          content: [
            { type: "text", text: `${status ?? "?"} ${p.url()}` },
          ],
          details: { status, finalUrl: p.url() },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser-eval",
    label: "Browser Eval",
    description:
      "Evaluate JS in the current page. Pass an expression ('localStorage.length'), a function ('() => Object.keys(localStorage)', 'async () => { ... }'), or an already-called IIFE — all three forms work. Return value must be JSON-serializable; for DOM nodes return primitive properties (.outerHTML, .textContent, .value) rather than the node itself.",
    promptSnippet:
      "Run JS in the live page to read localStorage / cookies, decode a JWT, inspect form or component state, or fire a fetch with custom headers",
    promptGuidelines: [
      "Use browser-eval to inspect runtime state (localStorage, cookies, in-page variables, JWT contents, computed styles) instead of guessing from source.",
    ],
    parameters: Type.Object({
      expression: Type.String({ description: "Expression or function source" }),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        // Playwright's evaluate(string) treats the string as an expression.
        // A user-written `() => foo` therefore evaluates to a function *value*
        // rather than calling it.
        //
        // Previous attempt: a regex that detected arrow/function shapes and
        // wrapped them in `(<src>)()`. That double-wrapped already-called
        // IIFEs like `(() => 42)()` into `((() => 42)())()` → `42()` → TypeError.
        //
        // Robust approach: ask the page itself. Evaluate the source once,
        // and if the result is a function, call it. This handles all three
        // forms (plain expr, function value, IIFE) without ambiguity.
        const src = params.expression;
        const wrapped = `(() => { const __v = (${src}); return typeof __v === 'function' ? __v() : __v; })()`;
        try {
          const result = await p.evaluate(wrapped);
          const text =
            typeof result === "string"
              ? result
              : (JSON.stringify(result, null, 2) ?? String(result));
          return { content: [{ type: "text", text }], details: { result } };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Keep the success/error result shape identical so the tool's
          // inferred return type stays a single union member — the error
          // text already lives in `content[].text`, no need to duplicate it
          // into details.
          return {
            content: [{ type: "text", text: `eval error: ${msg}` }],
            details: { result: undefined },
            isError: true,
          };
        }
      });
    },
  });

  pi.registerTool({
    name: "browser-console",
    label: "Browser Console",
    description:
      "Drain buffered console + pageerror entries (oldest first). With clear=true (default) the ENTIRE buffer is wiped after read, not just the entries returned — this is intentional, so subsequent calls observe a fresh window of activity rather than re-walking the same noise. Pass clear=false to peek without draining.",
    promptSnippet:
      "Read JS errors and console output captured since last drain — reach for this whenever a page seems broken without an obvious network cause",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max entries (default 100)" })),
      filter: Type.Optional(
        Type.String({ description: "Only entries whose text/location contains this substring" }),
      ),
      clear: Type.Optional(
        Type.Boolean({
          description:
            "Clear the entire buffer after read (not just returned entries). Default true.",
        }),
      ),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const limit = normalizeReadLimit(params.limit);
        const filter = params.filter;
        const filtered = filter
          ? consoleBuf.filter(
              (e) => e.text.includes(filter) || (e.location ?? "").includes(filter),
            )
          : consoleBuf.slice();
        const out = takeLast(filtered, limit);
        if (params.clear ?? true) consoleBuf.length = 0;
        const text =
          out
            .map(
              (e) =>
                `[${new Date(e.ts).toISOString()}] ${e.type}: ${e.text}${e.location ? `  @ ${e.location}` : ""}`,
            )
            .join("\n") || "(empty)";
        return { content: [{ type: "text", text }], details: { entries: out } };
      });
    },
  });

  pi.registerTool({
    name: "browser-network",
    label: "Browser Network",
    promptSnippet:
      "Inspect the actual HTTP requests the page made — status, method, URL, and (with verbose=true) selected headers. Credential-bearing header values are redacted. Use for 401 / 403 / CORS debugging",
    promptGuidelines: [
      "Use browser-network with verbose=true (and urlFilter to narrow scope) for any auth or CORS issue. It shows header names and non-sensitive values the browser actually sent; authorization, cookie, API-key, and token values are always redacted.",
    ],
    description:
      "Drain buffered network requests. Default text output is one terse line per request ('<status> <method> <url>') to keep context small.\n\nOpt-in for headers: set verbose=true to inline a curated set of request/response headers on each returned row (authorization, apikey, content-type, x-client-info, accept-profile, content-profile, prefer, location, www-authenticate, retry-after). Pass includeHeaders=['cookie','cache-control',...] to add more for this call only (case-insensitive). Cookie, authorization, API-key, and token header values are always returned as [REDACTED]. Best paired with urlFilter / status so headers only appear on the rows you care about.\n\nClear semantics: with clear=true (default) the ENTIRE buffer is wiped after read, not just the returned entries — this is intentional, so subsequent calls observe a fresh window of activity rather than re-walking the same subresource noise. Pass clear=false to peek without draining.\n\nCaveat: fetches whose body is never consumed (e.g. `await fetch(url)` without `.text()`/`.json()`) often appear here as 'ERR ... net::ERR_ABORTED' even though the JS side saw a successful response — Chromium cancels the body stream and Playwright reports requestfailed. Consume the body if you want a clean status row.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      urlFilter: Type.Optional(Type.String({ description: "Substring filter on URL" })),
      status: Type.Optional(Type.Number({ description: "Exact HTTP status to match" })),
      verbose: Type.Optional(
        Type.Boolean({
          description:
            "Inline a curated set of request/response headers on each row. Off by default to keep context small.",
        }),
      ),
      includeHeaders: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Extra header names (case-insensitive) to surface alongside the curated default set. Implies verbose=true.",
        }),
      ),
      clear: Type.Optional(
        Type.Boolean({
          description:
            "Clear the entire buffer after read (not just returned entries). Default true.",
        }),
      ),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        let entries = netBuf.slice();
        if (params.urlFilter) {
          const needle = params.urlFilter;
          entries = entries.filter((e) => e.url.includes(needle));
        }
        if (params.status != null) {
          const wanted = params.status;
          entries = entries.filter((e) => e.status === wanted);
        }
        const out = takeLast(entries, normalizeReadLimit(params.limit)).map((e) => ({
          ...e,
          requestHeaders: e.requestHeaders ? redactHeaders(e.requestHeaders) : undefined,
          responseHeaders: e.responseHeaders ? redactHeaders(e.responseHeaders) : undefined,
        }));
        if (params.clear ?? true) netBuf.length = 0;

        const extra = (params.includeHeaders ?? []).map((h: string) => h.toLowerCase());
        const showHeaders = params.verbose === true || extra.length > 0;
        const allow = new Set([...KEEP_HEADERS, ...extra]);

        const lines: string[] = [];
        for (const e of out) {
          lines.push(
            `${e.status ?? "ERR"} ${e.method} ${e.url}${e.failure ? `  (${e.failure})` : ""}`,
          );
          if (showHeaders) {
            const reqH = e.requestHeaders ? filterHeaders(e.requestHeaders, allow) : {};
            for (const [k, v] of Object.entries(reqH)) lines.push(`  → ${k}: ${v}`);
            const resH = e.responseHeaders ? filterHeaders(e.responseHeaders, allow) : {};
            for (const [k, v] of Object.entries(resH)) lines.push(`  ← ${k}: ${v}`);
          }
        }
        const text = lines.join("\n") || "(empty)";
        return { content: [{ type: "text", text }], details: { entries: out } };
      });
    },
  });

  pi.registerTool({
    name: "browser-fill",
    label: "Browser Fill",
    description: "Type a value into the input matching the selector.",
    promptSnippet:
      "Type into an input on the live page (dispatches input / change events properly, unlike a raw .value= assignment)",
    parameters: Type.Object({
      selector: Type.String(),
      value: Type.String(),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        await p.fill(params.selector, params.value);
        return {
          content: [{ type: "text", text: `filled ${params.selector}` }],
          details: {},
        };
      });
    },
  });

  pi.registerTool({
    name: "browser-click",
    label: "Browser Click",
    description:
      "Click the element matching the selector. CSS selectors and Playwright text= / role= selectors supported. Note: CSS attribute selectors match HTML attributes, not DOM properties — e.g. `button[type=submit]` will NOT match `<button>Submit</button>` even though that button's DOM `.type === 'submit'` by default. For semantic matching prefer `text=Submit` or `role=button[name=Submit]`.",
    promptSnippet:
      "Click an element on the live page — drives the app the way a user would, including form submits and SPA navigations",
    parameters: Type.Object({
      selector: Type.String(),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        await p.click(params.selector);
        return {
          content: [{ type: "text", text: `clicked ${params.selector}` }],
          details: {},
        };
      });
    },
  });

  pi.registerTool({
    name: "browser-screenshot",
    label: "Browser Screenshot",
    description:
      "Save a PNG screenshot to a temp file and return its path. Use the read tool on that path to view it (separate step so vision-token cost is paid only when you choose).",
    promptSnippet:
      "Capture a PNG of the current page when DOM / state inspection isn't enough and you need to see the visual",
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        const dir = mkdtempSync(join(tmpdir(), "pi-browser-"));
        screenshotDirs.add(dir);
        const file = join(dir, "screenshot.png");
        await p.screenshot({ path: file, fullPage: params.fullPage ?? false, type: "png" });
        return {
          content: [{ type: "text", text: file }],
          details: { path: file },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser-close",
    label: "Browser Close",
    description: "Close the persistent browser context. Next browser-* call relaunches.",
    promptSnippet:
      "Tear down the headless browser (rarely needed; auto-cleans on session end)",
    parameters: Type.Object({}),
    async execute() {
      return serialize(async () => {
        await teardown();
        return { content: [{ type: "text", text: "browser closed" }], details: {} };
      });
    },
  });

  pi.registerCommand("browser", {
    description: "Toggle browser tools; /browser status shows tool and open-page details",
    handler: async (args, ctx) => {
      const cmd = (args || "").trim().toLowerCase();
      if (cmd === "status") {
        const toolState = enabled ? "enabled" : "disabled (run /browser)";
        const procState =
          page && !page.isClosed() ? `, open at ${page.url()}` : "";
        ctx.ui.notify(`browser tools: ${toolState}${procState}`, "info");
        return;
      }

      if (enabled) {
        const wasRunning = !!(page && !page.isClosed());
        await disable(ctx);
        ctx.ui.notify(
          wasRunning ? "browser tools disabled, browser closed" : "browser tools disabled",
          "info",
        );
        return;
      }

      await enable(ctx);
      ctx.ui.notify("browser tools enabled", "info");
    },
  });

  // Default-off gate: tools stay registered (visible in pi.getAllTools(),
  // command discovery normal) but their promptSnippet / promptGuidelines
  // drop out of the system prompt and they're not callable until /browser
  // toggles them on. The actual setActiveTools call happens in the session_start
  // handler above, because pi forbids action methods during the factory.
}
