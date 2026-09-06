import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function clear(pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Start a new session",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}
