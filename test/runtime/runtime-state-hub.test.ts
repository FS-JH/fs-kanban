import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type {
	RuntimeAggregateBoardData,
	RuntimeBoardData,
	RuntimeProjectSummary,
	RuntimeWorkspaceStateResponse,
} from "../../src/core/api-contract.js";
import { createRuntimeStateHub } from "../../src/server/runtime-state-hub.js";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function createEmptyBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

function createWorkspaceState(repoPath: string): RuntimeWorkspaceStateResponse {
	return {
		repoPath,
		statePath: `${repoPath}/.kanban/workspace-state.json`,
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: createEmptyBoard(),
		sessions: {},
		revision: 1,
	};
}

function createProjectSummary(id: string): RuntimeProjectSummary {
	return {
		id,
		name: id,
		path: `/tmp/${id}`,
		taskCounts: {
			backlog: 0,
			in_progress: 0,
			review: 0,
			trash: 0,
		},
	};
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Could not determine test server port.");
	}
	return address.port;
}

async function connectWebSocket(url: string): Promise<{ socket: WebSocket; messages: unknown[] }> {
	const socket = new WebSocket(url);
	const messages: unknown[] = [];
	socket.on("message", (raw) => {
		messages.push(JSON.parse(String(raw)));
	});
	await new Promise<void>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			reject(new Error(`Timed out connecting websocket: ${url}`));
		}, 5_000);
		socket.once("open", () => {
			clearTimeout(timeoutId);
			resolve();
		});
		socket.once("error", (error) => {
			clearTimeout(timeoutId);
			reject(error);
		});
	});
	return { socket, messages };
}

describe("runtime state hub connection ordering", () => {
	const cleanupCallbacks: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanupCallbacks.length > 0) {
			const callback = cleanupCallbacks.pop();
			if (!callback) {
				continue;
			}
			await callback();
		}
	});

	it("sends the workspace snapshot before project broadcasts reach a new client", async () => {
		const projects = [createProjectSummary("workspace-1")];
		const workspaceState = createWorkspaceState("/tmp/workspace-1");
		const hub = createRuntimeStateHub({
			workspaceRegistry: {
				resolveWorkspaceForStream: async () => ({
					workspaceId: "workspace-1",
					workspacePath: "/tmp/workspace-1",
					removedRequestedWorkspacePath: null,
					didPruneProjects: false,
				}),
				buildProjectsPayload: async () => {
					await delay(40);
					return {
						currentProjectId: "workspace-1",
						projects,
					};
				},
				buildWorkspaceStateSnapshot: async () => {
					await delay(80);
					return workspaceState;
				},
				invalidateWorkspaceSnapshotCache: () => {},
				buildAggregateBoardSnapshot: async () => ({
					board: {
						columns: [
							{ id: "in_progress", title: "In Progress", cards: [] },
							{ id: "review", title: "Review", cards: [] },
						],
					} satisfies RuntimeAggregateBoardData,
					generatedAt: Date.now(),
				}),
			},
		});
		cleanupCallbacks.push(async () => {
			await hub.close();
		});

		const server = createServer();
		server.on("upgrade", (request, socket, head) => {
			const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			hub.handleUpgrade(request, socket, head, {
				requestedWorkspaceId: requestUrl.searchParams.get("workspaceId"),
			});
		});
		const port = await listen(server);
		cleanupCallbacks.push(
			async () =>
				await new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				}),
		);

		const { socket, messages } = await connectWebSocket(
			`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=workspace-1`,
		);
		cleanupCallbacks.push(
			async () =>
				await new Promise<void>((resolve) => {
					socket.once("close", () => resolve());
					socket.close();
				}),
		);

		void hub.broadcastRuntimeProjectsUpdated("workspace-1");
		await delay(200);

		expect(messages.length).toBeGreaterThan(0);
		expect((messages[0] as { type?: string }).type).toBe("snapshot");
	});

	it("sends the aggregate snapshot before project broadcasts reach a new aggregate client", async () => {
		const projects = [createProjectSummary("workspace-1")];
		const hub = createRuntimeStateHub({
			workspaceRegistry: {
				resolveWorkspaceForStream: async () => ({
					workspaceId: null,
					workspacePath: null,
					removedRequestedWorkspacePath: null,
					didPruneProjects: false,
				}),
				buildProjectsPayload: async () => {
					await delay(40);
					return {
						currentProjectId: "workspace-1",
						projects,
					};
				},
				buildWorkspaceStateSnapshot: async () => createWorkspaceState("/tmp/workspace-1"),
				invalidateWorkspaceSnapshotCache: () => {},
				buildAggregateBoardSnapshot: async () => {
					await delay(80);
					return {
						board: {
							columns: [
								{ id: "in_progress", title: "In Progress", cards: [] },
								{ id: "review", title: "Review", cards: [] },
							],
						} satisfies RuntimeAggregateBoardData,
						generatedAt: Date.now(),
					};
				},
			},
		});
		cleanupCallbacks.push(async () => {
			await hub.close();
		});

		const server = createServer();
		server.on("upgrade", (request, socket, head) => {
			const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			hub.handleUpgrade(request, socket, head, {
				requestedWorkspaceId: requestUrl.searchParams.get("workspaceId"),
				isAggregateView: requestUrl.searchParams.get("view") === "all-projects",
			});
		});
		const port = await listen(server);
		cleanupCallbacks.push(
			async () =>
				await new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				}),
		);

		const { socket, messages } = await connectWebSocket(`ws://127.0.0.1:${port}/api/runtime/ws?view=all-projects`);
		cleanupCallbacks.push(
			async () =>
				await new Promise<void>((resolve) => {
					socket.once("close", () => resolve());
					socket.close();
				}),
		);

		void hub.broadcastRuntimeProjectsUpdated("workspace-1");
		await delay(200);

		expect(messages.length).toBeGreaterThan(0);
		expect((messages[0] as { type?: string }).type).toBe("aggregate_snapshot");
	});

	it("reuses cached workspace snapshots across repeated workspace connections", async () => {
		const projects = [createProjectSummary("workspace-1")];
		const workspaceState = createWorkspaceState("/tmp/workspace-1");
		let workspaceSnapshotBuildCount = 0;
		const hub = createRuntimeStateHub({
			workspaceRegistry: {
				resolveWorkspaceForStream: async () => ({
					workspaceId: "workspace-1",
					workspacePath: "/tmp/workspace-1",
					removedRequestedWorkspacePath: null,
					didPruneProjects: false,
				}),
				buildProjectsPayload: async () => ({
					currentProjectId: "workspace-1",
					projects,
				}),
				buildWorkspaceStateSnapshot: async () => {
					workspaceSnapshotBuildCount += 1;
					await delay(40);
					return workspaceState;
				},
				invalidateWorkspaceSnapshotCache: () => {},
				buildAggregateBoardSnapshot: async () => ({
					board: {
						columns: [
							{ id: "in_progress", title: "In Progress", cards: [] },
							{ id: "review", title: "Review", cards: [] },
						],
					} satisfies RuntimeAggregateBoardData,
					generatedAt: Date.now(),
				}),
			},
		});
		cleanupCallbacks.push(async () => {
			await hub.close();
		});

		const server = createServer();
		server.on("upgrade", (request, socket, head) => {
			const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			hub.handleUpgrade(request, socket, head, {
				requestedWorkspaceId: requestUrl.searchParams.get("workspaceId"),
			});
		});
		const port = await listen(server);
		cleanupCallbacks.push(
			async () =>
				await new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				}),
		);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const { socket, messages } = await connectWebSocket(
				`ws://127.0.0.1:${port}/api/runtime/ws?workspaceId=workspace-1`,
			);
			await delay(100);
			expect((messages[0] as { type?: string }).type).toBe("snapshot");
			await new Promise<void>((resolve) => {
				socket.once("close", () => resolve());
				socket.close();
			});
		}

		expect(workspaceSnapshotBuildCount).toBe(1);
	});
});
