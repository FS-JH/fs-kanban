import { describe, expect, it, vi } from "vitest";

import { EngineAdapter, type EngineLaunchSpec, type EngineRunInput } from "../../../src/agents/engine-adapter.js";
import { EngineRouter } from "../../../src/agents/engine-router.js";

class FakeAdapter extends EngineAdapter {
	constructor(
		providerId: string,
		private readonly responses: Array<{
			ok: boolean;
			error?: string | null;
			timedOut?: boolean;
		}>,
		private readonly canRun = true,
	) {
		super(providerId, `${providerId}-binary`);
	}

	get available(): boolean {
		return this.canRun;
	}

	buildLaunchSpec(input: EngineRunInput): EngineLaunchSpec {
		return {
			command: this.binary,
			args: [input.taskId],
			cwd: input.cwd,
			stdin: input.prompt,
		};
	}

	override async run(input: EngineRunInput) {
		const response = this.responses.shift() ?? { ok: false, error: "engine_unavailable", timedOut: false };
		return {
			ok: response.ok,
			rawOutput: input.prompt,
			parsed: {},
			error: response.error ?? null,
			timedOut: response.timedOut ?? false,
			provider: this.providerId,
			exitCode: response.ok ? 0 : 1,
		};
	}
}

describe("engine router", () => {
	it("falls back between providers in role order", async () => {
		const router = new EngineRouter({
			providers: {
				codex_cli: new FakeAdapter("codex_cli", [{ ok: false, error: "timeout", timedOut: true }]),
				claude_cli: new FakeAdapter("claude_cli", [{ ok: true }]),
			},
			roleRoutes: {
				implementer: ["codex_cli", "claude_cli"],
			},
			providerFallbackOrder: ["codex_cli", "claude_cli"],
			cooldownSeconds: 1,
		});

		const result = await router.runForRole({
			role: "implementer",
			prompt: "hello",
			cwd: "/tmp",
		});

		expect(result.ok).toBe(true);
		expect(result.provider).toBe("claude_cli");
	});

	it("marks timed-out providers on cooldown", async () => {
		vi.useFakeTimers();
		try {
			const router = new EngineRouter({
				providers: {
					codex_cli: new FakeAdapter("codex_cli", [{ ok: false, error: "timeout", timedOut: true }]),
				},
				roleRoutes: {
					implementer: ["codex_cli"],
				},
				cooldownSeconds: 2,
			});

			await router.runForRole({
				role: "implementer",
				prompt: "hello",
				cwd: "/tmp",
			});

			expect(router.providerStatuses()[0]?.cooldownUntil).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("exposes whether any provider is available", () => {
		const router = new EngineRouter({
			providers: {
				codex_cli: new FakeAdapter("codex_cli", [], false),
				claude_cli: new FakeAdapter("claude_cli", [], true),
			},
		});

		expect(router.anyAvailable).toBe(true);
	});
});
