/**
 * When the prompt editor has focus:
 *   1. active text selection    -> copy it to the clipboard
 *   2. autocomplete popup open  -> close the popup
 *   3. agent running/retrying   -> abort the current turn or retry
 *   4. idle                     -> clear the editor and show
 *                                  "Press Ctrl+C again to exit";
 *                                  a second Ctrl+C within 1s exits pi.
 *
 * Requires ~/.pi/agent/keybindings.json to release ctrl+c from the built-in
 * actions, which would otherwise consume it before the editor wrapper below
 * (app.clear fires in the editor's action-handler loop, and tui.input.copy
 * is consumed before the autocomplete branch in the base editor):
 *   { "app.clear": [], "tui.input.copy": [] }
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export default function claudeCtrlC(pi: ExtensionAPI) {
	const EXIT_WINDOW_MS = 1000;
	const STATUS_KEY = "zzz-claude-ctrl-c";

	// TUI instance (TuiAltScreen in fullscreen mode, TuiMainScreen otherwise).
	// Only TuiAltScreen has hasActiveSelection()/copyActiveSelectionToClipboard().
	let tui: unknown;
	let latestCtx: ExtensionContext | undefined;
	let armedAt = 0;
	let hintCtx: ExtensionContext | undefined;
	let hintTimer: ReturnType<typeof setTimeout> | undefined;

	const handleCtrlC = (abortActiveOperation?: () => void) => {
		const ctx = latestCtx;
		if (!ctx) return;

		// 1. Active selection (fullscreen transcript, mouse-dragged) -> copy
		const alt = tui as
			| {
					hasActiveSelection?: () => boolean;
					copyActiveSelectionToClipboard?: () => Promise<boolean>;
			  }
			| undefined;
		if (alt?.hasActiveSelection?.() && alt.copyActiveSelectionToClipboard) {
			void alt.copyActiveSelectionToClipboard();
			return;
		}

		// 2. Agent running -> abort the current turn
		if (!ctx.isIdle()) {
			if (abortActiveOperation) abortActiveOperation();
			else ctx.abort();
			return;
		}

		// 3. Idle: first press clears + arms the exit window,
		//    second press within the window exits pi.
		const now = Date.now();
		if (now - armedAt < EXIT_WINDOW_MS) {
			armedAt = 0;
			if (hintTimer) {
				clearTimeout(hintTimer);
				hintTimer = undefined;
			}
			hintCtx = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.shutdown();
			return;
		}
		armedAt = now;
		hintCtx = ctx;
		ctx.ui.setEditorText("");
		ctx.ui.setStatus(STATUS_KEY, "🔄️ Press ctrl+c again to exit");
		if (hintTimer) clearTimeout(hintTimer);
		hintTimer = setTimeout(() => {
			hintTimer = undefined;
			armedAt = 0;
			hintCtx?.ui.setStatus(STATUS_KEY, undefined);
			hintCtx = undefined;
		}, EXIT_WINDOW_MS);
	};

	class ClaudeCtrlCEditor extends CustomEditor {
		handleInput(data: string): void {
			if (matchesKey(data, "ctrl+c")) {
				if (this.isShowingAutocomplete()) {
					// Built-in path: ctrl+c is still bound to tui.select.cancel,
					// so the base editor closes the popup for us.
					super.handleInput(data);
					return;
				}
				handleCtrlC(() => {
					if (this.onEscape) this.onEscape();
					else latestCtx?.abort();
				});
				return;
			}
			super.handleInput(data);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		latestCtx = ctx;
		ctx.ui.setWidget(
			"claude-ctrl-c",
			(capturedTui) => {
				tui = capturedTui;
				return {
					render: () => [] as string[],
					invalidate: () => {},
				};
			},
			{ placement: "belowEditor" },
		);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new ClaudeCtrlCEditor(tui, theme, keybindings));
	});
}
