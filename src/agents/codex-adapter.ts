import { join } from "node:path";
import { tmpdir } from "node:os";

import { EngineAdapter, type EngineLaunchSpec, type EngineRunInput, isBinaryAvailableOnPath } from "./engine-adapter.js";

function sanitizeTaskId(taskId: string): string {
	return taskId.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

export interface CodexCliAdapterOptions {
	binary?: string;
	enableDangerousAutonomy?: boolean;
}

export class CodexCliEngineAdapter extends EngineAdapter {
	private readonly enableDangerousAutonomy: boolean;

	constructor(options: CodexCliAdapterOptions = {}) {
		super("codex_cli", options.binary?.trim() || "codex");
		this.enableDangerousAutonomy = Boolean(options.enableDangerousAutonomy);
	}

	get available(): boolean {
		return isBinaryAvailableOnPath(this.binary);
	}

	buildLaunchSpec(input: EngineRunInput): EngineLaunchSpec {
		const outputFilePath = join(tmpdir(), `fs-kanban-${sanitizeTaskId(input.taskId)}.txt`);
		const args = ["exec", "--full-auto", "--ephemeral", "-C", input.cwd, "-o", outputFilePath, "-"];
		if (this.enableDangerousAutonomy) {
			args.unshift("--dangerously-bypass-approvals-and-sandbox");
		}
		return {
			command: this.binary,
			args,
			cwd: input.cwd,
			stdin: input.prompt,
			captureOutputFilePath: outputFilePath,
			timeoutSeconds: input.timeoutSeconds,
		};
	}
}
