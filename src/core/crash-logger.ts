import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

function resolveLogDirectory(): string {
	const override = process.env.KANBAN_LOG_DIR;
	if (override && override.trim().length > 0) {
		return override.trim();
	}
	const home = homedir();
	if (platform() === "darwin") {
		return join(home, "Library", "Logs", "fs-kanban");
	}
	if (platform() === "win32") {
		const appData = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(home, "AppData", "Local");
		return join(appData, "fs-kanban", "logs");
	}
	const xdgState = process.env.XDG_STATE_HOME;
	if (xdgState && xdgState.trim().length > 0) {
		return join(xdgState.trim(), "fs-kanban", "logs");
	}
	return join(home, ".fs-kanban", "logs");
}

const LOG_DIR = resolveLogDirectory();
const LOG_FILE = join(LOG_DIR, "fs-kanban.log");

let initialized = false;

function ensureLogDirSync(): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
	} catch {
		// Best-effort. If we cannot create the dir, falls back to stderr only.
	}
}

function formatEntry(level: string, context: string, detail: string): string {
	const timestamp = new Date().toISOString();
	return `[${timestamp}] ${level} ${context}: ${detail}\n`;
}

function stringifyError(error: unknown): string {
	if (error instanceof Error) {
		return error.stack ?? `${error.name}: ${error.message}`;
	}
	if (typeof error === "string") {
		return error;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function writeLogSync(entry: string): void {
	try {
		appendFileSync(LOG_FILE, entry);
	} catch {
		// Fall through to stderr below; do not throw from a logger.
	}
}

export function getKanbanLogFilePath(): string {
	return LOG_FILE;
}

export function logError(context: string, error: unknown): void {
	if (!initialized) {
		ensureLogDirSync();
		initialized = true;
	}
	const detail = stringifyError(error);
	const entry = formatEntry("ERROR", context, detail);
	writeLogSync(entry);
	process.stderr.write(entry);
}

export function logInfo(context: string, message: string): void {
	if (!initialized) {
		ensureLogDirSync();
		initialized = true;
	}
	const entry = formatEntry("INFO ", context, message);
	writeLogSync(entry);
}

let crashHandlersInstalled = false;

export interface CrashHandlerOptions {
	/**
	 * Invoked after an uncaught exception has been logged. The caller (CLI
	 * entrypoint) is responsible for terminating the process so a supervisor
	 * such as pm2 / launchd can restart us cleanly instead of leaving us in
	 * an unknown state. Kept as a callback because process.exit is confined
	 * to the CLI entrypoint by lint policy.
	 */
	onFatalUncaughtException: (error: unknown, origin: string) => void;
}

export function installCrashHandlers(options: CrashHandlerOptions): void {
	if (crashHandlersInstalled) {
		return;
	}
	crashHandlersInstalled = true;
	ensureLogDirSync();
	initialized = true;

	process.on("uncaughtException", (error, origin) => {
		logError(`uncaughtException[${origin}]`, error);
		options.onFatalUncaughtException(error, origin);
	});

	process.on("unhandledRejection", (reason) => {
		// Do not exit on unhandledRejection. Many library promises are fire-and-
		// forget by design and crashing here causes more harm than good. Logging
		// gives us breadcrumbs we previously lacked entirely.
		logError("unhandledRejection", reason);
	});

	process.on("warning", (warning) => {
		if (warning.name === "DeprecationWarning") {
			return;
		}
		logError(`processWarning[${warning.name}]`, warning);
	});

	logInfo("crash-logger", `Crash handlers installed (log file: ${LOG_FILE})`);
}
