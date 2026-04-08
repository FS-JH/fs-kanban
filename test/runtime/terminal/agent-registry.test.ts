import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
	resolveBinaryLocation: vi.fn(),
}));

vi.mock("../../../src/terminal/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
	resolveBinaryLocation: commandDiscoveryMocks.resolveBinaryLocation,
}));

import type { RuntimeConfigState } from "../../../src/config/runtime-config.js";
import {
	buildRuntimeConfigResponse,
	detectInstalledCommands,
	resolveAgentCommand,
} from "../../../src/terminal/agent-registry.js";

function createRuntimeConfigState(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		selectedAgentId: "claude",
		fallbackAgentId: null,
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		...overrides,
	};
}

beforeEach(() => {
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
	commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
	commandDiscoveryMocks.resolveBinaryLocation.mockReset();
	commandDiscoveryMocks.resolveBinaryLocation.mockReturnValue(null);
	delete process.env.KANBAN_DEBUG_MODE;
	delete process.env.DEBUG_MODE;
	delete process.env.debug_mode;
});

describe("agent-registry", () => {
	it("detects installed commands from the inherited PATH", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");

		const detected = detectInstalledCommands();

		expect(detected).toEqual(["claude"]);
		expect(commandDiscoveryMocks.isBinaryAvailableOnPath).toHaveBeenCalledTimes(3);
	});

	it("treats shell-only agents as unavailable", () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "npx");

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }));

		expect(resolved).toBeNull();
	});

	it("uses a resolved absolute binary path when the agent is installed outside PATH", () => {
		commandDiscoveryMocks.resolveBinaryLocation.mockImplementation((binary: string) =>
			binary === "claude" ? "/Users/test/Library/Application Support/Claude/claude-code-vm/2.1.92/claude" : null,
		);

		const resolved = resolveAgentCommand(createRuntimeConfigState({ selectedAgentId: "claude" }));

		expect(resolved).toEqual({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "/Users/test/Library/Application Support/Claude/claude-code-vm/2.1.92/claude",
			args: [],
		});
	});
});

describe("buildRuntimeConfigResponse", () => {
	it("keeps curated agent default args independent of autonomous mode", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: true,
		});

		const response = buildRuntimeConfigResponse(config);

		expect(response.agentAutonomousModeEnabled).toBe(true);
		expect(response.agents.map((agent) => agent.id)).toEqual(["codex", "claude"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
	});

	it("omits autonomous flags from curated agent commands when disabled", () => {
		const config = createRuntimeConfigState({
			agentAutonomousModeEnabled: false,
		});
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockImplementation((binary: string) => binary === "claude");
		commandDiscoveryMocks.resolveBinaryLocation.mockImplementation((binary: string) =>
			binary === "claude" ? "/resolved/claude" : null,
		);

		const response = buildRuntimeConfigResponse(config);

		expect(response.agentAutonomousModeEnabled).toBe(false);
		expect(response.agents.map((agent) => agent.id)).toEqual(["codex", "claude"]);
		expect(response.agents.find((agent) => agent.id === "claude")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "codex")?.defaultArgs).toEqual([]);
		expect(response.agents.find((agent) => agent.id === "claude")?.command).toBe("claude");
		expect(response.agents.find((agent) => agent.id === "codex")?.command).toBe("codex");
		expect(response.effectiveCommand).toBe("claude");
	});

	it("sets debug mode from runtime environment variables", () => {
		process.env.KANBAN_DEBUG_MODE = "true";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState());
		expect(response.debugModeEnabled).toBe(true);
	});

	it("supports debug_mode fallback env name", () => {
		process.env.debug_mode = "1";
		const response = buildRuntimeConfigResponse(createRuntimeConfigState());
		expect(response.debugModeEnabled).toBe(true);
	});
});
