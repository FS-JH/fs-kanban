import { beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import { TerminalSessionManager } from "../../../src/terminal/session-manager.js";

interface MockSpawnRequest {
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		getOutputHistory: vi.fn(() => []),
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

describe("TerminalSessionManager auto-restart", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
	});

	it("restarts an attached agent session after it exits", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		spawnedSessions[0]?.triggerExit(130);

		await vi.waitFor(() => {
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(2);
		});
		expect(manager.getSummary("task-1")?.state).toBe("running");
		expect(manager.getSummary("task-1")?.pid).toBe(222);
	});

	it("does not restart an attached agent session after an explicit stop", async () => {
		const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-1", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-1",
			prompt: "Fix the bug",
		});

		manager.stopTaskSession("task-1");
		spawnedSessions[0]?.triggerExit(0);
		await Promise.resolve();
		await Promise.resolve();

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(manager.getSummary("task-1")?.state).toBe("awaiting_review");
		expect(manager.getSummary("task-1")?.pid).toBeNull();
	});

	it("does not restart an attached agent session when KANBAN_DISABLE_AUTO_RESTART=1", async () => {
		// AUTO_RESTART_DISABLED is captured at module load, so reset modules and
		// re-import with the env var set. vi.hoisted mocks re-bind automatically.
		const previousValue = process.env.KANBAN_DISABLE_AUTO_RESTART;
		process.env.KANBAN_DISABLE_AUTO_RESTART = "1";
		vi.resetModules();
		try {
			const { TerminalSessionManager: TerminalSessionManagerWithDisableFlag } = await import(
				"../../../src/terminal/session-manager.js"
			);

			const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
			ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
				const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
				spawnedSessions.push(session);
				return session;
			});

			const manager = new TerminalSessionManagerWithDisableFlag();
			manager.attach("task-1", {
				onState: vi.fn(),
				onOutput: vi.fn(),
				onExit: vi.fn(),
			});

			await manager.startTaskSession({
				taskId: "task-1",
				agentId: "codex",
				binary: "codex",
				args: [],
				cwd: "/tmp/task-1",
				prompt: "Fix the bug",
			});

			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);

			// Simulate an external SIGKILL (no stopTaskSession was called).
			spawnedSessions[0]?.triggerExit(137);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			// With the disable flag set, the auto-restart MUST NOT fire.
			expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
			expect(manager.getSummary("task-1")?.pid).toBeNull();
		} finally {
			if (previousValue === undefined) {
				delete process.env.KANBAN_DISABLE_AUTO_RESTART;
			} else {
				process.env.KANBAN_DISABLE_AUTO_RESTART = previousValue;
			}
			vi.resetModules();
		}
	});
});
