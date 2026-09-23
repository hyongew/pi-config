import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type ThinkMode = "off" | "low" | "medium" | "high" | "xhigh";
type ActiveThinkMode = Exclude<ThinkMode, "off">;

const STATE_ENTRY = "qwen-think-state";
const STATE_FILE = join(getAgentDir(), "extensions", "qwen-think", "config.json");
const TAGS: Record<ActiveThinkMode, string> = {
	low: "<|think_low|>",
	medium: "<|think_medium|>",
	high: "<|think_high|>",
	xhigh: "<|think_xhigh|>",
};
const ARGUMENTS: Record<string, ThinkMode> = {
	low: "low",
	med: "medium",
	high: "high",
	xhigh: "xhigh",
};
const MODE_ORDER: ThinkMode[] = ["off", "low", "medium", "high", "xhigh"];
const DEFAULT_MODE: ThinkMode = "medium";

function isSubagentProcess(): boolean {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH);
	return (Number.isFinite(depth) && depth > 0) || process.env.PI_SUBAGENT_AGENT !== undefined;
}

function isThinkMode(value: unknown): value is ThinkMode {
	return value === "off" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function readStateFile(): ThinkMode | undefined {
	if (!existsSync(STATE_FILE)) return undefined;

	try {
		const data = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { mode?: unknown };
		return isThinkMode(data.mode) ? data.mode : undefined;
	} catch {
		return undefined;
	}
}

function readSessionMode(ctx: ExtensionContext): ThinkMode | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;

		const mode = (entry.data as { mode?: unknown } | undefined)?.mode;
		if (isThinkMode(mode)) return mode;
	}
	return undefined;
}

function persistMode(mode: ThinkMode): void {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify({ mode }, null, 2)}\n`, "utf-8");
}

function updateStatus(ctx: ExtensionContext, mode: ThinkMode): void {
	ctx.ui.setStatus(
		"qwen-think",
		mode === "off" ? undefined : ctx.ui.theme.fg("muted", `📖 think_${mode}`),
	);
}

export default function qwenThink(pi: ExtensionAPI): void {
	const subagent = isSubagentProcess();
	let mode: ThinkMode = DEFAULT_MODE;

	pi.on("session_start", async (_event, ctx) => {
		if (subagent) {
			ctx.ui.setStatus("qwen-think", undefined);
			return;
		}

		mode = readStateFile() ?? readSessionMode(ctx) ?? DEFAULT_MODE;
		updateStatus(ctx, mode);
	});

	pi.on("input", async (event) => {
		// Pi handles extension commands before this hook. Other slash-prefixed
		// input may be a skill or prompt template, which Pi expands afterward.
		if (mode === "off" || subagent || event.text.startsWith("/")) return;
		if (Object.values(TAGS).some((tag) => event.text.startsWith(tag))) return;

		return {
			action: "transform",
			text: `${TAGS[mode]}\n${event.text}`,
			images: event.images,
		};
	});

	pi.registerCommand("qwen-think", {
		description: "Set the Qwen thinking mode: low, med, high, or xhigh. No argument cycles modes",
		handler: async (args, ctx) => {
			if (subagent) {
				ctx.ui.notify("Thinking modes are disabled for subagents.", "info");
				return;
			}

			const argument = args.trim().toLowerCase();
			const nextMode = argument === ""
				? MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length]
				: ARGUMENTS[argument];
			if (!nextMode) {
				ctx.ui.notify("Usage: /qwen-think [low|med|high|xhigh]", "info");
				return;
			}

			try {
				persistMode(nextMode);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Unable to persist think mode: ${message}`, "error");
				return;
			}

			mode = nextMode;
			pi.appendEntry(STATE_ENTRY, { mode });
			updateStatus(ctx, mode);
			ctx.ui.notify(`Think mode set to ${mode}`, "info");
		},
	});
}
