import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { parse as shellParse } from "shell-quote";

type Severity = "catastrophic" | "high" | "medium";

type Risk = {
	severity: Severity;
	reasons: string[];
};

type OpToken = { op: string; [k: string]: unknown };

type Token = string | OpToken;

const CRITICAL_COUNTDOWN_SECONDS = 5;
const countdownInterruptKeys = [Key.space];

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status",
	"diff",
	"log",
	"show",
	"rev-parse",
	"ls-files",
	"describe",
]);

const SHELL_INTERPRETERS = new Set([
	"ash",
	"bash",
	"cmd",
	"dash",
	"fish",
	"ksh",
	"node",
	"perl",
	"powershell",
	"pwsh",
	"python",
	"python3",
	"ruby",
	"sh",
	"zsh",
]);

function commandName(raw: string): string {
	const name = raw.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? raw.toLowerCase();
	return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

function unwrapCommand(args: string[]): { cmd: string; rest: string[] } {
	let index = 0;
	while (index < args.length) {
		const name = commandName(args[index]);
		if (name === "command" || name === "exec" || name === "builtin") {
			index++;
			continue;
		}
		if (name === "env") {
			index++;
			while (index < args.length && (args[index].startsWith("-") || args[index].includes("="))) index++;
			continue;
		}
		return { cmd: name, rest: args.slice(index + 1) };
	}
	return { cmd: "", rest: [] };
}

function parseGitInvocation(args: string[]): { sub?: string; subArgs: string[] } {
	let index = 0;
	const optionsWithValues = new Set([
		"-C",
		"-c",
		"--config-env",
		"--exec-path",
		"--git-dir",
		"--namespace",
		"--super-prefix",
		"--work-tree",
	]);

	while (index < args.length) {
		const arg = args[index];
		if (arg === "--") {
			index++;
			break;
		}
		if (optionsWithValues.has(arg)) {
			index += 2;
			continue;
		}
		if ([...optionsWithValues].some((option) => arg.startsWith(`${option}=`))) {
			index++;
			continue;
		}
		if (arg.startsWith("-")) {
			index++;
			continue;
		}
		return { sub: commandName(arg), subArgs: args.slice(index + 1) };
	}
	return { subArgs: [] };
}

function hasRecursiveFlag(args: string[]): boolean {
	return args.some((arg) => arg === "--recursive" || /^-[^-]*r/i.test(arg));
}

function hasForceFlag(args: string[]): boolean {
	return args.some((arg) => arg === "--force" || arg.startsWith("--force-with-lease") || /^-[^-]*f/i.test(arg));
}

function hasHardResetFlag(args: string[]): boolean {
	return args.some((arg) => arg === "--hard");
}

function isReadOnlyDiskCommand(cmd: string, args: string[]): boolean {
	const normalizedArgs = args.map((arg) => arg.toLowerCase());
	const first = normalizedArgs[0];
	const second = normalizedArgs[1];
	if (cmd === "lsblk") return true;
	if (cmd === "diskutil") return first === "list" || first === "info" || (first === "apfs" && second === "list");
	if (cmd === "hdiutil") return ["info", "imageinfo", "checksum"].includes(first ?? "");
	if (cmd === "gpt") return normalizedArgs.includes("show");
	if (cmd === "asr") return first === "imagescan" || first === "verify";
	if (cmd === "parted" || cmd === "fdisk" || cmd === "gdisk") return normalizedArgs.includes("-l") || normalizedArgs.includes("--list") || normalizedArgs.includes("print");
	if (cmd === "sgdisk") return normalizedArgs.includes("-p") || normalizedArgs.includes("--print");
	if (cmd === "cryptsetup") return ["status", "luksdump", "isluks"].includes(first ?? "");
	if (cmd === "zpool") return ["list", "status", "get", "history"].includes(first ?? "");
	return false;
}

function nextPipelineCommand(segment: Token[], pipeIndex: number): string | undefined {
	const following: string[] = [];
	for (let index = pipeIndex + 1; index < segment.length; index++) {
		const token = segment[index];
		if (isOpToken(token)) break;
		following.push(token);
	}
	return following.length > 0 ? unwrapCommand(following).cmd : undefined;
}

function hasPipeToShell(segment: Token[]): boolean {
	return segment.some(
		(token, index) => isOpToken(token) && token.op === "|" && SHELL_INTERPRETERS.has(nextPipelineCommand(segment, index) ?? ""),
	);
}

function hasPipelineCommand(segment: Token[], names: Set<string>): boolean {
	return segment.some(
		(token, index) => isOpToken(token) && token.op === "|" && names.has(nextPipelineCommand(segment, index) ?? ""),
	);
}

function isOpToken(t: Token): t is OpToken {
	return typeof t === "object" && t !== null && "op" in t;
}

function tokensToStrings(tokens: Token[]): string[] {
	return tokens.filter((t) => typeof t === "string") as string[];
}

function splitOnOps(tokens: Token[], splitOps: string[]): Token[][] {
	const out: Token[][] = [];
	let current: Token[] = [];
	for (const t of tokens) {
		if (isOpToken(t) && splitOps.includes(t.op)) {
			if (current.length) out.push(current);
			current = [];
			continue;
		}
		current.push(t);
	}
	if (current.length) out.push(current);
	return out;
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag) || args.some((a) => a.startsWith(flag) && flag.length === 2 && a.startsWith("-"));
}

function anyArgStartsWith(args: string[], prefix: string): boolean {
	return args.some((a) => a.startsWith(prefix));
}

function analyseSegment(seg: Token[]): Risk | null {
	const reasons: string[] = [];
	let severity: Severity = "medium";
	let catastrophic = false;

	const ops = seg.filter(isOpToken).map((o) => o.op);
	const args = tokensToStrings(seg);
	if (args.length === 0) return null;

	const { cmd, rest } = unwrapCommand(args);

	// Shell redirection / pipes are handled on the whole command, but keep some segment checks too.
	if (hasPipeToShell(seg)) {
		reasons.push("pipe to a shell (possible remote code execution)");
		severity = "high";
		catastrophic = true;
	}
	if (hasPipelineCommand(seg, new Set(["tee"]))) {
		reasons.push("pipeline writes through tee");
		severity = severity === "high" ? "high" : "medium";
	}

	if (SHELL_INTERPRETERS.has(cmd) && !rest.some((arg) => ["--help", "--version", "-V"].includes(arg))) {
		reasons.push(`${cmd} (shell or interpreter execution)`);
		severity = "high";
		catastrophic = true;
	}

	if (cmd === "find" && rest.some((arg) => ["-delete", "-exec", "-execdir"].includes(arg))) {
		reasons.push("find command execution or deletion");
		severity = "high";
		catastrophic = true;
	}

	if (cmd === "xargs" && rest.some((arg) => ["rm", "rmdir", "unlink", ...SHELL_INTERPRETERS].includes(commandName(arg)))) {
		reasons.push("xargs invokes deletion or code execution");
		severity = "high";
		catastrophic = true;
	}

	// Privilege escalation is treated as catastrophic because the wrapped
	// command may hide an otherwise catastrophic operation from this parser.
	if (["sudo", "doas", "su", "pkexec", "runas"].includes(cmd)) {
		reasons.push(`${cmd} (opaque privilege escalation)`);
		severity = "high";
		catastrophic = true;
	}

	// rm/rmdir/unlink
	if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink") {
		const recursive = hasRecursiveFlag(rest);
		const forced = hasForceFlag(rest);
		const glob = ops.includes("glob");
		severity = recursive || forced || glob ? "high" : "medium";
		if (recursive) catastrophic = true;
		reasons.push(`${cmd} (file deletion)`);
		if (recursive) reasons.push("recursive delete (-r/-R)");
		if (forced) reasons.push("forced delete (-f)");
		if (glob) reasons.push("glob pattern expansion (may delete many files)");
	}

	// Git operations. Read-only inspection commands do not need a prompt.
	if (cmd === "git") {
		const { sub, subArgs } = parseGitInvocation(rest);
		const writesOutput = subArgs.some((arg) => arg === "--output" || arg.startsWith("--output="));
		const dryRun = sub === "clean" && subArgs.some((arg) => arg === "-n" || arg === "--dry-run");
		const readOnly = (sub !== undefined && READ_ONLY_GIT_SUBCOMMANDS.has(sub) && !writesOutput) || dryRun;

		if (!readOnly) reasons.push(sub ? `git ${sub} (git command)` : "git (git command)");
		if (writesOutput) {
			severity = "medium";
			reasons.push("git output redirection (writes a file)");
		}

		if (sub === "rm") {
			severity = "high";
			reasons.push("git rm (deletes files from working tree and stages deletions)");
		}
		if (sub === "clean" && hasForceFlag(subArgs)) {
			severity = "high";
			reasons.push("git clean (can delete untracked files)");
			catastrophic = true;
		}
		if (sub === "reset" && hasHardResetFlag(subArgs)) {
			severity = "high";
			reasons.push("git reset --hard (discard changes)");
			catastrophic = true;
		}
		if (sub === "reset" && !hasHardResetFlag(subArgs)) {
			severity = "high";
			reasons.push("git reset (changes the index or working tree state)");
		}
		if ((sub === "checkout" || sub === "restore") && (subArgs.includes(".") || subArgs.includes("--") || subArgs.includes("--source"))) {
			severity = "high";
			reasons.push("git checkout/restore (can overwrite working tree)");
		}
		if (sub === "pull") {
			severity = "high";
			reasons.push("git pull (changes the working tree and integrates remote state)");
		}
		if (sub === "push") {
			severity = "high";
			reasons.push(hasForceFlag(subArgs) ? "git push --force (rewrite remote history)" : "git push (changes remote state)");
			if (hasForceFlag(subArgs)) catastrophic = true;
		}
		if (sub === "reflog" && subArgs.includes("expire")) {
			severity = "high";
			reasons.push("git reflog expire (can remove recovery history)");
			catastrophic = true;
		}
		if (sub === "gc" && subArgs.some((a) => a.startsWith("--prune"))) {
			severity = "high";
			reasons.push("git gc --prune (can permanently delete objects)");
			catastrophic = true;
		}
	}

	// truncate
	if (cmd === "truncate") {
		severity = "medium";
		reasons.push("truncate (in-place size change, can erase contents)");
	}
	if (cmd === "tee" && rest.length > 0) {
		severity = "medium";
		reasons.push("tee (writes command output to a file)");
	}

	// dd of=
	if (cmd === "dd" && (anyArgStartsWith(rest, "of=") || rest.includes("of"))) {
		severity = "high";
		reasons.push("dd with output file/device (can overwrite data)");
		if (rest.some((arg) => /^of=\/dev\//i.test(arg))) catastrophic = true;
	}

	// Disk / volume management. Read-only inspection commands do not need a prompt.
	// Linux: mkfs.*, wipefs, parted, fdisk, gdisk/sgdisk, lsblk, cryptsetup, LVM tools, zpool
	// macOS: diskutil, hdiutil, gpt, newfs_*, asr
	if (cmd.startsWith("mkfs")) {
		severity = "high";
		reasons.push("mkfs (filesystem formatting)");
		catastrophic = true;
	}
	if (cmd.startsWith("newfs_")) {
		severity = "high";
		reasons.push("newfs_* (filesystem formatting)");
		catastrophic = true;
	}
	if (cmd === "wipefs") {
		severity = "high";
		reasons.push("wipefs (disk signature wipe)");
		catastrophic = true;
	}
	if (cmd === "diskutil" && !isReadOnlyDiskCommand(cmd, rest)) {
		severity = "high";
		reasons.push("diskutil (disk management command)");
		if (rest.some((arg) => ["erasedisk", "erasevolume", "zerodisk", "secureerase", "reformat", "partitiondisk", "deletevolume"].includes(arg.toLowerCase()))) {
			reasons.push("diskutil erase (destructive disk operation)");
			catastrophic = true;
		}
	}
	if (cmd === "hdiutil" && !isReadOnlyDiskCommand(cmd, rest)) {
		severity = "high";
		reasons.push("hdiutil (disk image management command)");
	}
	if (cmd === "gpt" && !isReadOnlyDiskCommand(cmd, rest)) {
		severity = "high";
		reasons.push("gpt (partition table manipulation)");
		catastrophic = true;
	}
	if (cmd === "asr" && !isReadOnlyDiskCommand(cmd, rest)) {
		severity = "high";
		reasons.push("asr (Apple Software Restore; can overwrite volumes)");
		catastrophic = true;
	}
	if ((cmd === "parted" || cmd === "fdisk" || cmd === "gdisk" || cmd === "sgdisk") && !isReadOnlyDiskCommand(cmd, rest)) {
		severity = "high";
		reasons.push(`${cmd} (disk/partition management)`);
		catastrophic = true;
	}
	if (cmd === "cryptsetup" && !isReadOnlyDiskCommand(cmd, rest)) {
		severity = "high";
		reasons.push("cryptsetup (disk encryption management)");
		if (["erase", "luksformat", "reencrypt", "resize"].includes(rest[0]?.toLowerCase() ?? "")) {
			catastrophic = true;
		}
	}
	if (cmd === "pvcreate" || cmd === "vgcreate" || cmd === "lvcreate") {
		severity = "high";
		reasons.push(`${cmd} (LVM volume management)`);
		catastrophic = true;
	}
	if (cmd === "zpool" && !isReadOnlyDiskCommand(cmd, rest)) {
		severity = "high";
		reasons.push("zpool (ZFS pool management)");
		if (["destroy", "labelclear", "remove"].includes(rest[0]?.toLowerCase() ?? "")) {
			catastrophic = true;
		}
	}

	// chmod/chown recursive
	if (cmd === "chmod" && (hasRecursiveFlag(rest) || rest.includes("--recursive"))) {
		severity = "high";
		reasons.push("chmod -R (recursive permission changes)");
	}
	if (cmd === "chown" && (hasRecursiveFlag(rest) || rest.includes("--recursive"))) {
		severity = "high";
		reasons.push("chown -R (recursive ownership changes)");
	}

	// mv/cp overwriting
	if (cmd === "mv" && (rest.includes("-f") || rest.includes("--force"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("mv --force/-f (can overwrite files)");
	}
	if (cmd === "cp" && (rest.includes("-f") || rest.includes("--force"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("cp --force/-f (can overwrite files)");
	}

	// sed/perl in-place
	if (cmd === "sed" && (hasFlag(rest, "-i") || rest.includes("--in-place"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("sed -i (in-place file modification)");
	}
	if (cmd === "perl" && (rest.includes("-pi") || (rest.includes("-p") && rest.includes("-i")))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("perl -pi/-i (in-place file modification)");
	}

	// kill/shutdown/systemctl
	if (cmd === "kill" || cmd === "pkill" || cmd === "killall") {
		const probeOnly = rest.includes("-0") || rest.includes("-l") || rest.includes("--list");
		if (!probeOnly) {
			severity = cmd === "kill" ? "medium" : "high";
			reasons.push(`${cmd} (process termination)`);
		}
		if (rest.some((arg) => ["-9", "-KILL", "-SIGKILL"].includes(arg.toUpperCase()))) {
			severity = "high";
			reasons.push("SIGKILL (-9)");
		}
	}
	if (cmd === "shutdown" || cmd === "reboot" || cmd === "halt" || cmd === "poweroff") {
		severity = "high";
		reasons.push(`${cmd} (system power operation)`);
	}
	if (cmd === "systemctl" && (rest.includes("stop") || rest.includes("disable"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("systemctl stop/disable (service disruption)");
	}

	// Remote execution patterns
	if ((cmd === "curl" || cmd === "wget") && hasPipeToShell(seg)) {
		severity = "high";
		reasons.push("curl/wget piped to a shell (remote code execution)");
	}

	// Infra deletes
	if (cmd === "kubectl" && rest.includes("delete")) {
		severity = "high";
		reasons.push("kubectl delete (resource deletion)");
		if (rest.some((arg) => ["--all", "-a", "-a=", "namespace", "namespaces", "ns", "--all-namespaces"].includes(arg.toLowerCase()))) {
			catastrophic = true;
		}
	}
	if (cmd === "terraform" && rest.includes("destroy")) {
		severity = "high";
		reasons.push("terraform destroy (infrastructure teardown)");
		catastrophic = true;
	}
	if (cmd === "aws" && rest.includes("s3") && rest.includes("rm") && rest.includes("--recursive")) {
		severity = "high";
		reasons.push("aws s3 rm --recursive (bulk deletion)");
		catastrophic = true;
	}
	if (cmd === "aws" && rest.includes("s3") && rest.includes("rm") && !rest.includes("--recursive")) {
		severity = "high";
		reasons.push("aws s3 rm (cloud object deletion)");
	}
	if (cmd === "gcloud" && rest.includes("delete")) {
		severity = "high";
		reasons.push("gcloud delete (resource deletion)");
		if (rest.some((arg) => ["--all", "--all-resources"].includes(arg.toLowerCase()))) {
			catastrophic = true;
		}
	}

	if (reasons.length === 0) return null;
	return { severity: catastrophic ? "catastrophic" : severity, reasons };
}

function analyseBashCommand(command: string): Risk | null {
	let tokens: Token[];
	try {
		tokens = shellParse(command) as Token[];
	} catch {
		// Fallback: if we can't parse, treat it as questionable
		return { severity: "catastrophic", reasons: ["unparsed shell command (unable to analyse safely)"] };
	}

	const reasons: string[] = [];
	let severity: Severity = "medium";
	let catastrophic = false;

	// Whole-command operator checks
	const ops = tokens.filter(isOpToken).map((t) => t.op);
	if (ops.some((op) => op === ">" || op === ">>" || op === "2>" || op === "2>>")) {
		reasons.push("shell output redirection (can overwrite files)");
		severity = "medium";
	}
	// Segment analysis (split on &&, ||, ;)
	const segments = splitOnOps(tokens, ["&&", "||", ";"]);
	for (const seg of segments) {
		const segRisk = analyseSegment(seg);
		if (!segRisk) continue;
		if (segRisk.severity === "catastrophic") severity = "catastrophic";
		else if (segRisk.severity === "high" && severity !== "catastrophic") severity = "high";
		for (const r of segRisk.reasons) reasons.push(r);
	}

	// De-duplicate reasons
	const uniq = [...new Set(reasons)];
	if (uniq.length === 0) return null;
	return { severity, reasons: uniq };
}

const SHARED_UI_LOCK_KEY = "__piSharedUiLock";

function getSharedUiLock() {
	const globalState = globalThis as any;
	if (!globalState[SHARED_UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		globalState[SHARED_UI_LOCK_KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const previous = chain;
				let release!: () => void;
				chain = new Promise<void>((resolve) => {
					release = resolve;
				});
				return previous.then(fn).finally(() => release());
			},
		};
	}
	return globalState[SHARED_UI_LOCK_KEY] as {
		withLock<T>(fn: () => T | Promise<T>): Promise<T>;
	};
}

const sharedUiLock = getSharedUiLock();

function withUiLock<T>(fn: () => Promise<T>): Promise<T> {
	return sharedUiLock.withLock(fn);
}

function playQuestionNotificationSound(ctx: ExtensionContext): void {
	if (ctx.mode === "tui") {
		process.stdout.write("\u0007");
	}
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

async function promptRisk(ctx: ExtensionContext, command: string, risk: Risk): Promise<"yes" | "no"> {
	if (!ctx.hasUI) return "no";

	const critical = risk.severity === "catastrophic";
	const items = [
		{ value: "yes" as const, label: "Yes", description: "Run the command" },
		{ value: "no" as const, label: "No", description: "Skip the command and continue" },
	];

	playQuestionNotificationSound(ctx);
	const choice = await ctx.ui.custom<"yes" | "no">((tui: any, theme: any, _kb: any, done: (value: "yes" | "no") => void) => {
		const color = critical ? "error" : "warning";
		let optionIndex = 0;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;

		const finish = (value: "yes" | "no") => done(value);
		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			const title = critical ? "Critical bash command" : "High-risk bash command";

			add(theme.fg(color, "─".repeat(width)));
			addWrapped(lines, theme.fg(color, ` ${theme.bold(title)}`), width);
			lines.push("");
			addWrapped(
				lines,
				theme.fg("text", critical ? " This command may cause irreversible damage." : " This command was flagged as high risk."),
				width,
			);
			lines.push("");
			addWrapped(lines, theme.fg("muted", " Reasons:"), width);
			for (const reason of risk.reasons) {
				addWrapped(lines, theme.fg("muted", `- ${reason}`), width, " ");
			}
			lines.push("");
			addWrapped(lines, theme.fg("muted", " Command:"), width);
			addWrapped(lines, theme.fg("text", command), width, " ");
			lines.push("");
			addWrapped(lines, theme.fg("text", " Allow this command to run?"), width);
			lines.push("");

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				const selected = i === optionIndex;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const label = `${i + 1}. ${item.label}`;
				const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
				add(`${prefix}${styled}`);
				addWrapped(lines, theme.fg("muted", item.description), width, "     ");
			}

			lines.push("");
			add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
			add(theme.fg(color, "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(items.length - 1, optionIndex + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					finish(items[optionIndex].value);
					return;
				}
				if (matchesKey(data, Key.escape)) finish("no");
			},
		};
	});

	return choice ?? "no";
}

async function waitForCriticalCountdown(
	ctx: ExtensionContext,
	command: string,
	risk: Risk,
): Promise<"run" | "prompt"> {
	if (!ctx.hasUI || ctx.mode !== "tui") return "run";
	playQuestionNotificationSound(ctx);

	return ctx.ui.custom<"run" | "prompt">((tui: any, theme: any, _kb: any, done: (value: "run" | "prompt") => void) => {
		let remaining = CRITICAL_COUNTDOWN_SECONDS;
		let finished = false;
		const reasonsText = risk.reasons.map((reason) => `• ${reason}`).join("\n");
		const container = new Container();
		const countdownText = new Text("", 1, 0);

		const finish = (result: "run" | "prompt") => {
			if (finished) return;
			finished = true;
			clearInterval(timer);
			done(result);
		};

		const refresh = () => {
			countdownText.setText(
				theme.fg(
					"error",
					`Running automatically in ${remaining}s. Press Space to review before it runs.`,
				),
			);
			container.invalidate();
			tui.requestRender();
		};

		container.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));
		container.addChild(new Text(theme.fg("error", theme.bold("Critical bash command")), 1, 0));
		container.addChild(new Text("This command may cause irreversible damage.", 1, 0));
		container.addChild(new Text(reasonsText, 1, 0));
		container.addChild(new Text(`Command:\n${command}`, 1, 0));
		container.addChild(countdownText);
		container.addChild(new DynamicBorder((s: string) => theme.fg("error", s)));

		const timer = setInterval(() => {
			remaining--;
			if (remaining <= 0) {
				finish("run");
				return;
			}
			refresh();
		}, 1000);
		refresh();

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (countdownInterruptKeys.some((key) => matchesKey(data, key))) finish("prompt");
			},
		};
	});
}

export default function bashGuard(pi: ExtensionAPI): void {
	let enabled = true;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || !enabled) return;
		ctx.ui.setStatus("bash-guard", ctx.ui.theme.fg("accent", "🛡️ bash-guard"));
	});

	pi.registerCommand("bash-guard", {
		description: "Toggle high-risk Bash approvals and critical-command countdowns.",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.setStatus(
				"bash-guard",
				enabled ?
					ctx.ui.theme.fg("accent", "🛡️ bash-guard") :
					ctx.ui.theme.fg("error", "❗ bash-guard OFF")
			)
			ctx.ui.notify(
				`bash-guard ${enabled ? 'enabled' : 'disabled'}`,
				"info"
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const risk = analyseBashCommand(event.input.command);
		if (!risk || risk.severity === "medium") return;

		if (risk.severity === "catastrophic") {
			if (!enabled) {
				// In TUI mode, give the user a five-second chance to interrupt
				// autonomous execution and review the command.
				if (ctx.hasUI && ctx.mode === "tui") {
					const choice = await withUiLock(async () => {
						const countdown = await waitForCriticalCountdown(ctx, event.input.command, risk);
						return countdown === "run" ? "yes" : promptRisk(ctx, event.input.command, risk);
					});
					if (choice === "yes") return;
				} else {
					// Headless and RPC modes have no usable keyboard countdown.
					return;
				}
			} else if (ctx.hasUI && ctx.mode === "tui") {
				const choice = await withUiLock(() => promptRisk(ctx, event.input.command, risk));
				if (choice === "yes") return;
			} else {
				return {
					block: true,
					reason:
					"Blocked by bash-guard: critical Bash command requires interactive user approval, but no TUI is available. Do not retry or work around this command; continue with the next safe step if possible, otherwise stop and explain that approval is required.",
				};
			}

			return {
				block: true,
				terminate: true,
				reason:
					"The user denied this critical Bash command. It was not executed; end the current turn without retrying or replacing it.",
			};
		}

		if (!enabled) return;

		if (!ctx.hasUI || ctx.mode !== "tui") {
			return {
				block: true,
				reason:
					"Blocked by bash-guard: high-risk Bash command requires interactive user approval, but no TUI is available. Do not retry or work around this command; continue with the next safe step if possible, otherwise stop and explain that approval is required.",
			};
		}

		const choice = await withUiLock(() => promptRisk(ctx, event.input.command, risk));
		if (choice === "yes") return;

		return {
			block: true,
			terminate: true,
			reason:
				"The user denied this high-risk Bash command. It was not executed; end the current turn without retrying or replacing it.",
		};
	});
}
