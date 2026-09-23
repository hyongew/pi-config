import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function playBellSound(ctx: ExtensionContext): void {
	if (ctx.mode === "tui") {
		process.stdout.write("\u0007");
	}
}

export default function (pi: ExtensionAPI): void {
	pi.on("agent_settled", (_event, ctx) => {
		playBellSound(ctx);
	});
}
