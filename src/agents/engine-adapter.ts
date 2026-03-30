import { access, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";

export interface EngineResult {
	ok: boolean;
	rawOutput: string;
	parsed: Record<string, unknown>;
	error: string | null;
	timedOut: boolean;
	provider: string;
	exitCode: number | null;
}

export interface ProviderProbe {
	providerId: string;
	available: boolean;
	binary: string;
	authState: string;
	detail: string;
}

export interface EngineRunInput {
	taskId: string;
	prompt: string;
	cwd: string;
	timeoutSeconds?: number;
	outputSchema?: Record<string, unknown> | null;
	environment?: Record<string, string | undefined>;
	onStdout?: (chunk: string) => void;
}

export interface EngineLaunchSpec {
	command: string;
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	stdin?: string;
	captureOutputFilePath?: string;
	timeoutSeconds?: number;
}

export function isBinaryAvailableOnPath(binary: string): boolean {
	const trimmed = binary.trim();
	if (!trimmed) {
		return false;
	}
	try {
		const command = process.platform === "win32" ? "where" : "which";
		const args = process.platform === "win32" ? [trimmed] : ["-v", trimmed];
		const result = spawnSync(command, args, {
			stdio: "ignore",
			shell: false,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

async function readAvailableFile(path: string): Promise<string> {
	try {
		await access(path);
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

export abstract class EngineAdapter {
	constructor(
		public readonly providerId: string,
		public readonly binary: string,
	) {}

	abstract get available(): boolean;

	abstract buildLaunchSpec(input: EngineRunInput): EngineLaunchSpec;

	async run(input: EngineRunInput): Promise<EngineResult> {
		if (!this.available) {
			return {
				ok: false,
				rawOutput: "",
				parsed: {},
				error: "engine_unavailable",
				timedOut: false,
				provider: this.providerId,
				exitCode: 127,
			};
		}

		const spec = this.buildLaunchSpec(input);
		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: {
				...process.env,
				...spec.env,
			},
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const timeoutSeconds = spec.timeoutSeconds ?? input.timeoutSeconds ?? 600;
		let rawOutput = "";
		let timedOut = false;
		let exitCode: number | null = null;

		const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				// Best effort.
			}
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Best effort.
				}
			}, 2_000).unref();
		}, timeoutMs);
		timer.unref();

		child.stdout?.on("data", (chunk: Buffer | string) => {
			const text = String(chunk);
			rawOutput += text;
			input.onStdout?.(text);
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			const text = String(chunk);
			rawOutput += text;
			input.onStdout?.(text);
		});

		if (child.stdin && typeof spec.stdin === "string") {
			child.stdin.end(spec.stdin);
		} else if (child.stdin) {
			child.stdin.end();
		}

		try {
			exitCode = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => {
					clearTimeout(timer);
					resolve(code);
				});
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				rawOutput: "",
				parsed: {},
				error: message,
				timedOut: false,
				provider: this.providerId,
				exitCode: 127,
			};
		}

		if (spec.captureOutputFilePath) {
			rawOutput = `${rawOutput}${await readAvailableFile(spec.captureOutputFilePath)}`;
		}

		if (timedOut) {
			return {
				ok: false,
				rawOutput,
				parsed: {},
				error: "timeout",
				timedOut: true,
				provider: this.providerId,
				exitCode: 124,
			};
		}

		return {
			ok: exitCode === 0,
			rawOutput,
			parsed: {},
			error: exitCode === 0 ? null : `exit_${exitCode ?? "unknown"}`,
			timedOut: false,
			provider: this.providerId,
			exitCode,
		};
	}

	terminateActive(): void {
		// Intentional no-op in the initial port.
	}

	probe(): ProviderProbe {
		return {
			providerId: this.providerId,
			available: this.available,
			binary: this.binary,
			authState: "unknown",
			detail: "",
		};
	}
}
