import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function playBellSound(ctx: ExtensionContext): void {
	if (ctx.mode === "tui") {
		process.stdout.write("\u0007");
	}
}

export default function (pi: ExtensionAPI): void {
	let turnWasAborted = false;

	pi.on("agent_start", () => {
		turnWasAborted = false;
	});

	pi.on("agent_end", (event, ctx) => {
		turnWasAborted ||=
			ctx.signal?.aborted === true ||
			event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
	});

	pi.on("agent_before_settle", (event) => {
		turnWasAborted ||= event.outcome === "aborted";
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!turnWasAborted) playBellSound(ctx);
		turnWasAborted = false;
	});
}
