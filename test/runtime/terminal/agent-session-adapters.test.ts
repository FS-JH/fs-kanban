import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract.js";
import { prepareAgentLaunch, type AgentAdapterLaunchInput } from "../../../src/terminal/agent-session-adapters.js";

const originalHome = process.env.HOME;
let tempHome: string | null = null;
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const originalExecPath = process.execPath;

const baseLaunch: AgentAdapterLaunchInput = {
	taskId: "task-1",
	agentId: "codex",
	binary: "/usr/bin/false",
	args: [],
	cwd: "/tmp",
	prompt: "",
};

function makeLaunchInput(overrides: Partial<AgentAdapterLaunchInput> = {}): AgentAdapterLaunchInput {
	return { ...baseLaunch, ...overrides };
}

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		mode: null,
		agentId: "codex",
		workspacePath: "/tmp",
		pid: 1,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-agent-adapters-"));
	process.env.HOME = tempHome;
	return tempHome;
}

function setKanbanProcessContext(): void {
	process.argv = ["node", "/Users/example/repo/dist/cli.js"];
	process.execArgv = [];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: "/usr/local/bin/node",
	});
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	process.argv = [...originalArgv];
	process.execArgv = [...originalExecArgv];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: originalExecPath,
	});
});

describe("prepareAgentLaunch", () => {
	it("codex detector emits agent.needs-input when prompt returns while running", async () => {
		const launch = await prepareAgentLaunch(makeLaunchInput({ agentId: "codex" }));
		const detect = launch.detectOutputTransition;
		expect(detect).toBeDefined();
		if (!detect) {
			throw new Error("Expected Codex output transition detector");
		}
		const ev = detect("\n› ", makeSummary({ agentId: "codex", state: "running" }));
		expect(ev).toEqual({ type: "agent.needs-input" });
	});

	it("codex detector still emits agent.prompt-ready when returning from awaiting_review/attention", async () => {
		const launch = await prepareAgentLaunch(makeLaunchInput({ agentId: "codex" }));
		const detect = launch.detectOutputTransition;
		if (!detect) {
			throw new Error("Expected Codex output transition detector");
		}
		const ev = detect(
			"\n› ",
			makeSummary({ agentId: "codex", state: "awaiting_review", reviewReason: "attention" }),
		);
		expect(ev).toEqual({ type: "agent.prompt-ready" });
	});

	it("claude detector emits agent.needs-input when prompt returns while running", async () => {
		const launch = await prepareAgentLaunch(makeLaunchInput({ agentId: "claude" }));
		const detect = launch.detectOutputTransition;
		expect(detect).toBeDefined();
		if (!detect) {
			throw new Error("Expected Claude output transition detector");
		}
		const data = "\n╭──╮\n│ > │\n╰──╯\n";
		const ev = detect(data, makeSummary({ agentId: "claude", state: "running" }));
		expect(ev).toEqual({ type: "agent.needs-input" });
	});

	it("claude detector emits agent.prompt-ready when returning from awaiting_review/attention", async () => {
		const launch = await prepareAgentLaunch(makeLaunchInput({ agentId: "claude" }));
		const detect = launch.detectOutputTransition;
		if (!detect) {
			throw new Error("Expected Claude output transition detector");
		}
		const ev = detect(
			"\n╭──╮\n│ > │\n╰──╯\n",
			makeSummary({ agentId: "claude", state: "awaiting_review", reviewReason: "attention" }),
		);
		expect(ev).toEqual({ type: "agent.prompt-ready" });
	});

	it("routes codex through the hooks codex-wrapper command", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const launchCommand = [launch.binary ?? "", ...launch.args].join(" ");
		expect(launchCommand).toContain("hooks");
		expect(launchCommand).toContain("codex-wrapper");
		expect(launchCommand).toContain("--real-binary");
		expect(launchCommand).toContain("codex");
		expect(launchCommand).toContain("--");
	});

	it("appends Kanban sidebar instructions for home Claude sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:claude:abc123",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const appendPromptIndex = launch.args.indexOf("--append-system-prompt");
		expect(appendPromptIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[appendPromptIndex + 1]).toContain("Kanban sidebar agent");
		expect(launch.args[appendPromptIndex + 1]).toContain(
			"'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create",
		);
	});

	it("appends Kanban sidebar instructions for home Codex sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:codex:abc123",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const configArgIndex = launch.args.indexOf("-c");
		expect(configArgIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[configArgIndex + 1]).toContain("developer_instructions=");
		expect(launch.args[configArgIndex + 1]).toContain("Kanban sidebar agent");
		expect(launch.args[configArgIndex + 1]).toContain(
			"'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create",
		);
	});

	it("writes Claude settings with explicit permission and tool hooks", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settingsPath = join(homedir(), ".config", "fs-kanban", "hooks", "claude", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, unknown>;
		};
		expect(settings.hooks?.PermissionRequest).toBeDefined();
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();
	});

	it("materializes task images for CLI prompts", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-images",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Inspect the attached design",
			images: [
				{
					id: "img-1",
					data: Buffer.from("hello").toString("base64"),
					mimeType: "image/png",
					name: "diagram.png",
				},
			],
		});

		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Attached reference images:");
		expect(initialPrompt).toContain("Task:\nInspect the attached design");

		const imagePathMatch = initialPrompt.match(/1\. (.+?) \(diagram\.png\)/);
		expect(imagePathMatch?.[1]).toBeDefined();
		const imagePath = imagePathMatch?.[1] ?? "";
		expect(existsSync(imagePath)).toBe(true);
		expect(readFileSync(imagePath).toString("utf8")).toBe("hello");
	});

	it("rejects unsupported legacy agent launches", async () => {
		setupTempHome();
		for (const legacyAgentId of ["cline", "gemini", "opencode", "droid"] as const) {
			await expect(
				prepareAgentLaunch({
					taskId: `task-${legacyAgentId}`,
					agentId: legacyAgentId as never,
					binary: legacyAgentId,
					args: [],
					cwd: "/tmp",
					prompt: "",
					workspaceId: "workspace-1",
				}),
			).rejects.toThrow(`Unsupported agent launch requested: ${legacyAgentId}`);
		}
	});

	it("adds resume flags for the supported agents", async () => {
		setupTempHome();

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(codexLaunch.args).toEqual(expect.arrayContaining(["resume", "--last"]));

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(claudeLaunch.args).toContain("--continue");
	});

	it("applies autonomous mode flags for the supported agents", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-auto",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-auto",
			agentId: "codex",
			binary: "codex",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");
	});

	it("preserves explicit autonomous args when autonomous mode is disabled", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-no-auto",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-no-auto",
			agentId: "codex",
			binary: "codex",
			args: ["--dangerously-bypass-approvals-and-sandbox"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");
	});

	it("keeps supervised approval mode off the dangerous bypass flags", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-supervised",
			agentId: "claude",
			binary: "claude",
			args: [],
			approvalMode: "supervised",
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).not.toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-supervised",
			agentId: "codex",
			binary: "codex",
			args: [],
			approvalMode: "supervised",
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
	});
});
