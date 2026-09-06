import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// This tool is loaded only by worker subagents. Keep the list intentionally
// small: file changes go through write/edit tools, while shell access is
// limited to read-only inspection and repository history.
const SAFE_COMMANDS = new Set([
	"pwd",
	"ls",
	"dir",
	"cat",
	"type",
	"head",
	"tail",
	"rg",
	"grep",
	"find",
	"where",
	"which",
	"git",
	"get-childitem",
	"get-content",
	"select-string",
	"test-path",
	"resolve-path",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"ls-files",
	"describe",
]);

const UNSAFE_SHELL_SYNTAX = /[\r\n;&|<>`$()]/;
const UNSAFE_READ_OPTIONS = /(?:^|\s)(?:-exec(?:dir)?|--exec(?:dir)?|--delete|--pre(?:-glob)?|--output(?:=|\s)|-o(?:\s|$))/i;
const UNSAFE_GIT_OPTIONS = /(?:^|\s)(?:-c(?:\s|=)|--config-env(?:=|\s)|--exec-path(?:=|\s)|--ext-diff|--textconv)/i;
const POWERSHELL_COMMANDS = new Set([
	"pwd",
	"dir",
	"type",
	"cat",
	"get-childitem",
	"get-content",
	"select-string",
	"test-path",
	"resolve-path",
]);
const MAX_OUTPUT_LENGTH = 20_000;
const COMMAND_TIMEOUT_MS = 60_000;

type SafeBashDetails = {
	blocked: boolean;
	command: string;
	exitCode?: number;
};

function commandName(command: string): string | undefined {
	const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
	const raw = match?.[1] ?? match?.[2] ?? match?.[3];
	if (!raw) return undefined;
	return raw.replaceAll("\\", "/").split("/").pop()?.toLowerCase();
}

function tokenize(command: string): string[] | undefined {
	const tokens: string[] = [];
	const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let cursor = 0;
	for (const match of command.matchAll(pattern)) {
		if (command.slice(cursor, match.index).trim()) return undefined;
		tokens.push(match[1] ?? match[2] ?? match[3]);
		cursor = (match.index ?? 0) + match[0].length;
	}
	return command.slice(cursor).trim() ? undefined : tokens;
}

function isSafeCommand(command: string): boolean {
	if (!command.trim() || UNSAFE_SHELL_SYNTAX.test(command)) return false;
	if (UNSAFE_READ_OPTIONS.test(command) || UNSAFE_GIT_OPTIONS.test(command)) return false;

	const tokens = tokenize(command);
	const name = commandName(command);
	if (!tokens || !name || !SAFE_COMMANDS.has(name)) return false;

	if (name !== "git") return true;
	const subcommand = tokens[0]?.toLowerCase() === "git"
		? tokens.slice(1).find((token) => !token.startsWith("-"))
		: undefined;
	return subcommand !== undefined && SAFE_GIT_SUBCOMMANDS.has(subcommand.toLowerCase());
}

function runSafeCommand(command: string, tokens: string[], cwd: string, signal: AbortSignal | undefined): Promise<{
	code: number;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolve) => {
		const name = tokens[0].toLowerCase();
		const usePowerShell = process.platform === "win32" && POWERSHELL_COMMANDS.has(name);
		const executable = usePowerShell ? "powershell.exe" : tokens[0];
		const args = usePowerShell
			? ["-NoProfile", "-NonInteractive", "-Command", command]
			: tokens.slice(1);
		const child = spawn(executable, args, {
			cwd,
			env: process.env,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			resolve({ code, stdout, stderr });
		};
		const abort = (): void => {
			child.kill();
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", () => finish(1));
		child.on("close", (code) => finish(code ?? 1));
	});
}

function limitOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_LENGTH) return text;
	return `${text.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`;
}

export default function safeBash(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "safe-bash",
		label: "safe-bash",
		description:
			"Run a command from the restricted read-only safe-bash allowlist. Use read/write/edit tools for file changes.",
		parameters: Type.Object({
			command: Type.String({ description: "One preapproved read-only command to run." }),
		}),
		async execute(_toolCallId, params, signal) {
			const command = params.command.trim();
			const tokens = tokenize(command);
			if (!tokens || !isSafeCommand(command)) {
				const details: SafeBashDetails = { blocked: true, command };
				return {
					content: [{
						type: "text" as const,
						text: "Blocked by safe-bash: command is not on the preapproved read-only allowlist.",
					}],
					details,
					isError: true,
				};
			}

			const result = await runSafeCommand(command, tokens, process.cwd(), signal);
			const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
			const details: SafeBashDetails = { blocked: false, command, exitCode: result.code };
			return {
				content: [{ type: "text" as const, text: limitOutput(output || `(exit code ${result.code})`) }],
				details,
				isError: result.code !== 0,
			};
		},
	});
}
