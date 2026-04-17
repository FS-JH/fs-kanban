import { readFile } from "node:fs/promises";
import {
	createServer as createHttpServer,
	type Server as HttpServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { join } from "node:path";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import packageJson from "../../package.json" with { type: "json" };
import {
	type RuntimeCommandRunResponse,
	type RuntimeTaskAttachment,
	type RuntimeWorkspaceStateResponse,
	runtimeTaskAttachmentUploadRequestSchema,
} from "../core/api-contract.js";
import {
	buildKanbanRuntimeUrl,
	getKanbanRuntimeHost,
	getKanbanRuntimeHttpsPort,
	getKanbanRuntimeOrigin,
	getKanbanRuntimePort,
	getKanbanRuntimeTlsCertPath,
	getKanbanRuntimeTlsKeyPath,
	isKanbanRuntimeHttpsEnabled,
} from "../core/runtime-endpoint.js";
import {
	getWorkspaceDirectoryPath,
	loadWorkspaceContextById,
	loadWorkspaceStateById,
} from "../state/workspace-state.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import { createTerminalWebSocketBridge } from "../terminal/ws-server.js";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../trpc/app-router.js";
import { createHooksApi } from "../trpc/hooks-api.js";
import { createProjectsApi } from "../trpc/projects-api.js";
import { createRuntimeApi } from "../trpc/runtime-api.js";
import { createWorkspaceApi } from "../trpc/workspace-api.js";
import {
	collectBoardAttachmentStorageKeys,
	getTaskAttachmentsRootPath,
	lookupTaskAttachmentContentType,
	pruneStaleUnreferencedTaskAttachments,
	resolveExistingStoredTaskAttachmentPath,
	storeTaskAttachment,
} from "../workspace/task-attachments.js";
import { getWebUiDir, normalizeRequestPath, readAsset } from "./assets.js";
import type { RuntimeStateHub } from "./runtime-state-hub.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

const KANBAN_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

interface DisposeTrackedWorkspaceResult {
	terminalManager: TerminalSessionManager | null;
	workspacePath: string | null;
}

export interface CreateRuntimeServerDependencies {
	workspaceRegistry: WorkspaceRegistry;
	runtimeStateHub: RuntimeStateHub;
	warn: (message: string) => void;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
	resolveProjectInputPath: (inputPath: string, basePath: string) => string;
	assertPathIsDirectory: (targetPath: string) => Promise<void>;
	hasGitRepository: (path: string) => boolean;
	disposeWorkspace: (
		workspaceId: string,
		options?: {
			stopTerminalSessions?: boolean;
		},
	) => DisposeTrackedWorkspaceResult;
	collectProjectWorktreeTaskIdsForRemoval: (board: RuntimeWorkspaceStateResponse["board"]) => Set<string>;
	pickDirectoryPathFromSystemDialog: () => string | null;
}

export interface RuntimeServer {
	url: string;
	close: () => Promise<void>;
}

type RuntimeHttpServer = HttpServer | HttpsServer;

const MAX_ATTACHMENT_UPLOAD_BODY_BYTES = 35 * 1024 * 1024;

function readWorkspaceIdFromRequest(request: IncomingMessage, requestUrl: URL): string | null {
	const headerValue = request.headers["x-kanban-workspace-id"];
	const headerWorkspaceId = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (typeof headerWorkspaceId === "string") {
		const normalized = headerWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	const queryWorkspaceId = requestUrl.searchParams.get("workspaceId");
	if (typeof queryWorkspaceId === "string") {
		const normalized = queryWorkspaceId.trim();
		if (normalized) {
			return normalized;
		}
	}
	return null;
}

function writeJsonResponse(response: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
	response.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(JSON.stringify(payload));
}

async function readJsonRequestBody(
	request: IncomingMessage,
	maxBytes: number = MAX_ATTACHMENT_UPLOAD_BODY_BYTES,
): Promise<unknown> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of request) {
		const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += bufferChunk.byteLength;
		if (totalBytes > maxBytes) {
			throw new Error("Request body exceeds the maximum supported size.");
		}
		chunks.push(bufferChunk);
	}
	if (chunks.length === 0) {
		throw new Error("Request body cannot be empty.");
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new Error("Request body must be valid JSON.");
	}
}

function findTaskAttachmentByStorageKey(
	board: RuntimeWorkspaceStateResponse["board"],
	storageKey: string,
): RuntimeTaskAttachment | null {
	for (const column of board.columns) {
		for (const card of column.cards) {
			for (const attachment of card.attachments ?? []) {
				if (attachment.storageKey === storageKey) {
					return attachment;
				}
			}
		}
	}
	return null;
}

export async function createRuntimeServer(deps: CreateRuntimeServerDependencies): Promise<RuntimeServer> {
	const webUiDir = getWebUiDir();

	try {
		await readFile(join(webUiDir, "index.html"));
	} catch {
		throw new Error("Could not find web UI assets. Run `npm run build` to generate and package the web UI.");
	}

	const resolveWorkspaceScopeFromRequest = async (
		request: IncomingMessage,
		requestUrl: URL,
	): Promise<{
		requestedWorkspaceId: string | null;
		workspaceScope: RuntimeTrpcWorkspaceScope | null;
	}> => {
		const requestedWorkspaceId = readWorkspaceIdFromRequest(request, requestUrl);
		if (!requestedWorkspaceId) {
			return {
				requestedWorkspaceId: null,
				workspaceScope: null,
			};
		}
		const requestedWorkspaceContext = await loadWorkspaceContextById(requestedWorkspaceId);
		if (!requestedWorkspaceContext) {
			return {
				requestedWorkspaceId,
				workspaceScope: null,
			};
		}
		return {
			requestedWorkspaceId,
			workspaceScope: {
				workspaceId: requestedWorkspaceContext.workspaceId,
				workspacePath: requestedWorkspaceContext.repoPath,
			},
		};
	};

	const getScopedTerminalManager = async (scope: RuntimeTrpcWorkspaceScope): Promise<TerminalSessionManager> =>
		await deps.ensureTerminalManagerForWorkspace(scope.workspaceId, scope.workspacePath);
	const prepareForStateReset = async (): Promise<void> => {
		const workspaceIds = new Set<string>();
		for (const { workspaceId } of deps.workspaceRegistry.listManagedWorkspaces()) {
			workspaceIds.add(workspaceId);
		}
		const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
		if (activeWorkspaceId) {
			workspaceIds.add(activeWorkspaceId);
		}
		for (const workspaceId of workspaceIds) {
			deps.disposeWorkspace(workspaceId, {
				stopTerminalSessions: true,
			});
		}
		deps.workspaceRegistry.clearActiveWorkspace();
	};

	const createTrpcContext = async (req: IncomingMessage): Promise<RuntimeTrpcContext> => {
		const requestUrl = new URL(req.url ?? "/", "http://localhost");
		const scope = await resolveWorkspaceScopeFromRequest(req, requestUrl);
		return {
			requestedWorkspaceId: scope.requestedWorkspaceId,
			workspaceScope: scope.workspaceScope,
			runtimeApi: createRuntimeApi({
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				getActiveRuntimeConfig: deps.workspaceRegistry.getActiveRuntimeConfig,
				loadScopedRuntimeConfig: deps.workspaceRegistry.loadScopedRuntimeConfig,
				setActiveRuntimeConfig: deps.workspaceRegistry.setActiveRuntimeConfig,
				getScopedTerminalManager,
				resolveInteractiveShellCommand: deps.resolveInteractiveShellCommand,
				runCommand: deps.runCommand,
				prepareForStateReset,
			}),
			workspaceApi: createWorkspaceApi({
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				buildWorkspaceStateSnapshot: deps.workspaceRegistry.buildWorkspaceStateSnapshot,
			}),
			projectsApi: createProjectsApi({
				getActiveWorkspacePath: deps.workspaceRegistry.getActiveWorkspacePath,
				getActiveWorkspaceId: deps.workspaceRegistry.getActiveWorkspaceId,
				rememberWorkspace: deps.workspaceRegistry.rememberWorkspace,
				setActiveWorkspace: deps.workspaceRegistry.setActiveWorkspace,
				clearActiveWorkspace: deps.workspaceRegistry.clearActiveWorkspace,
				resolveProjectInputPath: deps.resolveProjectInputPath,
				assertPathIsDirectory: deps.assertPathIsDirectory,
				hasGitRepository: deps.hasGitRepository,
				summarizeProjectTaskCounts: deps.workspaceRegistry.summarizeProjectTaskCounts,
				createProjectSummary: deps.workspaceRegistry.createProjectSummary,
				broadcastRuntimeProjectsUpdated: deps.runtimeStateHub.broadcastRuntimeProjectsUpdated,
				getTerminalManagerForWorkspace: deps.workspaceRegistry.getTerminalManagerForWorkspace,
				disposeWorkspace: deps.disposeWorkspace,
				collectProjectWorktreeTaskIdsForRemoval: deps.collectProjectWorktreeTaskIdsForRemoval,
				warn: deps.warn,
				buildProjectsPayload: deps.workspaceRegistry.buildProjectsPayload,
				pickDirectoryPathFromSystemDialog: deps.pickDirectoryPathFromSystemDialog,
			}),
			hooksApi: createHooksApi({
				getWorkspacePathById: deps.workspaceRegistry.getWorkspacePathById,
				ensureTerminalManagerForWorkspace: deps.ensureTerminalManagerForWorkspace,
				broadcastRuntimeWorkspaceStateUpdated: deps.runtimeStateHub.broadcastRuntimeWorkspaceStateUpdated,
				broadcastTaskReadyForReview: deps.runtimeStateHub.broadcastTaskReadyForReview,
			}),
		};
	};

	const trpcHttpHandler = createHTTPHandler({
		basePath: "/api/trpc/",
		router: runtimeAppRouter,
		createContext: async ({ req }) => await createTrpcContext(req),
	});

	const requestHandler = async (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => {
		try {
			const requestUrl = new URL(req.url ?? "/", "http://localhost");
			const pathname = normalizeRequestPath(requestUrl.pathname);
			if (pathname.startsWith("/api/trpc")) {
				await trpcHttpHandler(req, res);
				return;
			}
			if (pathname === "/api/attachments/upload") {
				if (req.method !== "POST") {
					writeJsonResponse(res, 405, { ok: false, error: "Method not allowed." });
					return;
				}
				const scope = await resolveWorkspaceScopeFromRequest(req, requestUrl);
				if (!scope.workspaceScope) {
					writeJsonResponse(res, scope.requestedWorkspaceId ? 404 : 400, {
						ok: false,
						error: scope.requestedWorkspaceId ? "Workspace not found." : "Missing workspaceId.",
					});
					return;
				}

				let requestBody: unknown;
				try {
					requestBody = await readJsonRequestBody(req);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					writeJsonResponse(res, 400, { ok: false, error: message });
					return;
				}

				const parsedUpload = runtimeTaskAttachmentUploadRequestSchema.safeParse(requestBody);
				if (!parsedUpload.success) {
					writeJsonResponse(res, 400, {
						ok: false,
						error: parsedUpload.error.issues[0]?.message ?? "Invalid attachment upload payload.",
					});
					return;
				}

				try {
					const workspaceId = scope.workspaceScope.workspaceId;
					const repoPath = scope.workspaceScope.workspacePath;
					const attachmentsRootPath = getTaskAttachmentsRootPath(getWorkspaceDirectoryPath(workspaceId));
					const attachment = await storeTaskAttachment(attachmentsRootPath, parsedUpload.data);
					const currentState = await loadWorkspaceStateById(workspaceId, repoPath);
					await pruneStaleUnreferencedTaskAttachments(
						attachmentsRootPath,
						collectBoardAttachmentStorageKeys(currentState.board),
					);
					writeJsonResponse(res, 200, {
						ok: true,
						attachment,
					});
					return;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					writeJsonResponse(res, 400, { ok: false, error: message });
					return;
				}
			}
			if (pathname === "/api/attachments/file") {
				if (req.method !== "GET") {
					writeJsonResponse(res, 405, { ok: false, error: "Method not allowed." });
					return;
				}
				const storageKey = requestUrl.searchParams.get("storageKey")?.trim() ?? "";
				if (!storageKey) {
					writeJsonResponse(res, 400, { ok: false, error: "Missing storageKey." });
					return;
				}
				const scope = await resolveWorkspaceScopeFromRequest(req, requestUrl);
				if (!scope.workspaceScope) {
					writeJsonResponse(res, scope.requestedWorkspaceId ? 404 : 400, {
						ok: false,
						error: scope.requestedWorkspaceId ? "Workspace not found." : "Missing workspaceId.",
					});
					return;
				}
				try {
					const workspaceId = scope.workspaceScope.workspaceId;
					const repoPath = scope.workspaceScope.workspacePath;
					const attachmentsRootPath = getTaskAttachmentsRootPath(getWorkspaceDirectoryPath(workspaceId));
					const filePath = await resolveExistingStoredTaskAttachmentPath(attachmentsRootPath, storageKey);
					if (!filePath) {
						writeJsonResponse(res, 404, { ok: false, error: "Attachment not found." });
						return;
					}
					const currentState = await loadWorkspaceStateById(workspaceId, repoPath);
					const attachment = findTaskAttachmentByStorageKey(currentState.board, storageKey);
					const content = await readFile(filePath);
					res.writeHead(200, {
						"Content-Type": lookupTaskAttachmentContentType(
							attachment ?? {
								mimeType: "",
								name: storageKey,
							},
						),
						"Cache-Control": "no-store",
					});
					res.end(content);
					return;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					writeJsonResponse(res, 400, { ok: false, error: message });
					return;
				}
			}
			if (pathname === "/api/health") {
				writeJsonResponse(res, 200, {
					status: "ok",
					version: KANBAN_VERSION,
					uptime: process.uptime(),
				});
				return;
			}
			if (pathname.startsWith("/api/")) {
				writeJsonResponse(res, 404, { error: "Not found" });
				return;
			}

			const asset = await readAsset(webUiDir, pathname);
			res.writeHead(200, {
				"Content-Type": asset.contentType,
				"Cache-Control": "no-store",
			});
			res.end(asset.content);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
		}
	};

	const httpServer = createHttpServer(requestHandler);
	// Tolerate misbehaving clients that open TCP connections and abort the
	// request mid-flight without closing the socket. Without these timeouts a
	// leaky client (e.g. the Foundation EA dashboard observed in production
	// leaving ~100 ESTABLISHED connections to port 3484) can back up the HTTP
	// server until /api/health times out.
	//
	// headersTimeout (10s): close connections that do not finish sending
	// headers in time. Node's default is 60s, far too long for localhost.
	// requestTimeout (30s): close connections that do not finish the full
	// request body in time.
	// keepAliveTimeout (5s): idle keep-alive connections drop after 5s so a
	// burst of opened-but-unused sockets cannot exhaust resources.
	httpServer.headersTimeout = 10_000;
	httpServer.requestTimeout = 30_000;
	httpServer.keepAliveTimeout = 5_000;
	const servers: RuntimeHttpServer[] = [httpServer];

	if (isKanbanRuntimeHttpsEnabled()) {
		const tlsCertPath = getKanbanRuntimeTlsCertPath();
		const tlsKeyPath = getKanbanRuntimeTlsKeyPath();
		if (!tlsCertPath || !tlsKeyPath) {
			throw new Error("HTTPS requested without both TLS cert and key paths.");
		}
		const [cert, key] = await Promise.all([readFile(tlsCertPath), readFile(tlsKeyPath)]);
		const httpsServer = createHttpsServer({ cert, key }, requestHandler);
		httpsServer.headersTimeout = 10_000;
		httpsServer.requestTimeout = 30_000;
		httpsServer.keepAliveTimeout = 5_000;
		servers.push(httpsServer);
	}

	const attachUpgradeHandlers = (server: RuntimeHttpServer) => {
		server.on("upgrade", (request, socket, head) => {
			let requestUrl: URL;
			try {
				requestUrl = new URL(request.url ?? "/", "http://localhost");
			} catch {
				socket.destroy();
				return;
			}
			if (normalizeRequestPath(requestUrl.pathname) !== "/api/runtime/ws") {
				return;
			}
			(request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled = true;
			const requestedWorkspaceId = requestUrl.searchParams.get("workspaceId")?.trim() || null;
			const isAggregateView = requestUrl.searchParams.get("view")?.trim() === "all-projects";
			deps.runtimeStateHub.handleUpgrade(request, socket, head, { requestedWorkspaceId, isAggregateView });
		});
	};
	for (const server of servers) {
		attachUpgradeHandlers(server);
	}
	const terminalWebSocketBridge = createTerminalWebSocketBridge({
		servers,
		resolveTerminalManager: (workspaceId) => deps.workspaceRegistry.getTerminalManagerForWorkspace(workspaceId),
		isTerminalIoWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/io",
		isTerminalControlWebSocketPath: (pathname) => normalizeRequestPath(pathname) === "/api/terminal/control",
	});
	for (const server of servers) {
		server.on("upgrade", (request, socket) => {
			const handled = (request as IncomingMessage & { __kanbanUpgradeHandled?: boolean }).__kanbanUpgradeHandled;
			if (handled) {
				return;
			}
			socket.destroy();
		});
	}

	await new Promise<void>((resolveListen, rejectListen) => {
		let settled = false;
		let remainingServers = servers.length;
		const onError = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			rejectListen(error);
		};
		for (const server of servers) {
			server.once("error", onError);
		}
		const onListening = (server: RuntimeHttpServer) => {
			server.off("error", onError);
			remainingServers -= 1;
			if (!settled && remainingServers === 0) {
				settled = true;
				resolveListen();
			}
		};
		httpServer.listen(getKanbanRuntimePort(), getKanbanRuntimeHost(), () => {
			onListening(httpServer);
		});
		if (servers.length > 1) {
			const httpsServer = servers[1];
			httpsServer?.listen(getKanbanRuntimeHttpsPort(), getKanbanRuntimeHost(), () => {
				onListening(httpsServer);
			});
		}
	});

	const httpAddress = httpServer.address();
	if (!httpAddress || typeof httpAddress === "string") {
		throw new Error("Failed to start local server.");
	}
	const activeWorkspaceId = deps.workspaceRegistry.getActiveWorkspaceId();
	const url = activeWorkspaceId
		? buildKanbanRuntimeUrl(`/${encodeURIComponent(activeWorkspaceId)}`)
		: getKanbanRuntimeOrigin();

	return {
		url,
		close: async () => {
			await deps.runtimeStateHub.close();
			await terminalWebSocketBridge.close();
			await Promise.all(
				servers.map(
					(server) =>
						new Promise<void>((resolveClose, rejectClose) => {
							server.close((error) => {
								if (error) {
									rejectClose(error);
									return;
								}
								resolveClose();
							});
						}),
				),
			);
		},
	};
}
