import { EngineAdapter, type EngineLaunchSpec, type EngineRunInput, isBinaryAvailableOnPath } from "./engine-adapter.js";

export interface ClaudeCliAdapterOptions {
	binary?: string;
	enableDangerousPermissions?: boolean;
}

export class ClaudeCliEngineAdapter extends EngineAdapter {
	private readonly enableDangerousPermissions: boolean;

	constructor(options: ClaudeCliAdapterOptions = {}) {
		super("claude_cli", options.binary?.trim() || "claude");
		this.enableDangerousPermissions = Boolean(options.enableDangerousPermissions);
	}

	get available(): boolean {
		return isBinaryAvailableOnPath(this.binary);
	}

	buildLaunchSpec(input: EngineRunInput): EngineLaunchSpec {
		const args = ["-p", input.prompt, "--output-format", "text"];
		if (this.enableDangerousPermissions) {
			args.push("--dangerously-skip-permissions");
		}
		return {
			command: this.binary,
			args,
			cwd: input.cwd,
			timeoutSeconds: input.timeoutSeconds,
		};
	}
}
