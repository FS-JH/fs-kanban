export const DEFAULT_KANBAN_RUNTIME_HOST = "127.0.0.1";
export const DEFAULT_KANBAN_RUNTIME_PORT = 3484;
export const DEFAULT_KANBAN_RUNTIME_HTTPS_PORT = 3443;

function normalizeRuntimeHost(rawHost: string | null | undefined, fallback: string): string {
	const normalized = rawHost?.trim();
	return normalized ? normalized : fallback;
}

let runtimeHost = normalizeRuntimeHost(process.env.KANBAN_RUNTIME_HOST, DEFAULT_KANBAN_RUNTIME_HOST);
let runtimeAdvertisedHost = normalizeRuntimeHost(process.env.KANBAN_RUNTIME_ADVERTISED_HOST, runtimeHost);

export function getKanbanRuntimeHost(): string {
	return runtimeHost;
}

export function getKanbanRuntimeAdvertisedHost(): string {
	return runtimeAdvertisedHost;
}

export function setKanbanRuntimeHost(host: string): void {
	const normalizedHost = normalizeRuntimeHost(host, DEFAULT_KANBAN_RUNTIME_HOST);
	runtimeHost = normalizedHost;
	process.env.KANBAN_RUNTIME_HOST = normalizedHost;
	if (!process.env.KANBAN_RUNTIME_ADVERTISED_HOST?.trim()) {
		runtimeAdvertisedHost = normalizedHost;
	}
}

export function setKanbanRuntimeAdvertisedHost(host: string | null | undefined): void {
	const normalizedHost = host?.trim();
	if (normalizedHost) {
		runtimeAdvertisedHost = normalizedHost;
		process.env.KANBAN_RUNTIME_ADVERTISED_HOST = normalizedHost;
		return;
	}
	runtimeAdvertisedHost = runtimeHost;
	delete process.env.KANBAN_RUNTIME_ADVERTISED_HOST;
}

function normalizeOptionalRuntimePath(rawPath: string | undefined): string | null {
	const normalizedPath = rawPath?.trim();
	return normalizedPath ? normalizedPath : null;
}

export function getKanbanRuntimeTlsCertPath(): string | null {
	return normalizeOptionalRuntimePath(process.env.KANBAN_RUNTIME_TLS_CERT) ?? normalizeOptionalRuntimePath(process.env.TLS_CERT);
}

export function getKanbanRuntimeTlsKeyPath(): string | null {
	return normalizeOptionalRuntimePath(process.env.KANBAN_RUNTIME_TLS_KEY) ?? normalizeOptionalRuntimePath(process.env.TLS_KEY);
}

export function isKanbanRuntimeHttpsEnabled(): boolean {
	return getKanbanRuntimeTlsCertPath() !== null && getKanbanRuntimeTlsKeyPath() !== null;
}

export function getKanbanRuntimeHttpsPort(): number {
	const rawPort =
		normalizeOptionalRuntimePath(process.env.KANBAN_RUNTIME_HTTPS_PORT) ??
		normalizeOptionalRuntimePath(process.env.HTTPS_PORT);
	return rawPort ? parseRuntimePort(rawPort) : DEFAULT_KANBAN_RUNTIME_HTTPS_PORT;
}

export function parseRuntimePort(rawPort: string | undefined): number {
	if (!rawPort) {
		return DEFAULT_KANBAN_RUNTIME_PORT;
	}
	const parsed = Number.parseInt(rawPort, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`Invalid KANBAN_RUNTIME_PORT value "${rawPort}". Expected an integer from 1-65535.`);
	}
	return parsed;
}

let runtimePort = parseRuntimePort(process.env.KANBAN_RUNTIME_PORT?.trim());

export function getKanbanRuntimePort(): number {
	return runtimePort;
}

export function setKanbanRuntimePort(port: number): void {
	const normalized = parseRuntimePort(String(port));
	runtimePort = normalized;
	process.env.KANBAN_RUNTIME_PORT = String(normalized);
}

export function getKanbanRuntimeBindOrigin(): string {
	return `http://${getKanbanRuntimeHost()}:${getKanbanRuntimePort()}`;
}

export function getKanbanRuntimeOrigin(): string {
	if (isKanbanRuntimeHttpsEnabled()) {
		return `https://${getKanbanRuntimeAdvertisedHost()}:${getKanbanRuntimeHttpsPort()}`;
	}
	return `http://${getKanbanRuntimeAdvertisedHost()}:${getKanbanRuntimePort()}`;
}

export function getKanbanRuntimeWsOrigin(): string {
	if (isKanbanRuntimeHttpsEnabled()) {
		return `wss://${getKanbanRuntimeAdvertisedHost()}:${getKanbanRuntimeHttpsPort()}`;
	}
	return `ws://${getKanbanRuntimeAdvertisedHost()}:${getKanbanRuntimePort()}`;
}

export function buildKanbanRuntimeBindUrl(pathname: string): string {
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return `${getKanbanRuntimeBindOrigin()}${normalizedPath}`;
}

export function buildKanbanRuntimeUrl(pathname: string): string {
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return `${getKanbanRuntimeOrigin()}${normalizedPath}`;
}

export function buildKanbanRuntimeWsUrl(pathname: string): string {
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return `${getKanbanRuntimeWsOrigin()}${normalizedPath}`;
}
