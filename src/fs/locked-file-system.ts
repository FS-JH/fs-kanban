import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import * as lockfile from "proper-lockfile";

// 30s stale threshold tolerates event-loop stalls under heavy load (polling,
// burst of git subprocess work). 10s was too tight and caused ECOMPROMISED
// errors when proper-lockfile could not touch the lockfile in time.
const DEFAULT_LOCK_STALE_MS = 30_000;

// Retry window must exceed the stale threshold so that a new process started
// immediately after an abrupt prior-process death can acquire the lock once it
// ages past the stale cutoff. 600 × (50-100ms) gives us a ~30-60s window;
// before, 200 × (25-50ms) gave 5-10s, frequently shorter than stale, so pm2
// restarts failed with "Lock file is already being held."
const DEFAULT_LOCK_RETRIES: NonNullable<LockOptions["retries"]> = {
	retries: 600,
	factor: 1,
	minTimeout: 50,
	maxTimeout: 100,
	randomize: false,
};

interface BaseLockRequest {
	path: string;
	staleMs?: number;
	retries?: LockOptions["retries"];
	onCompromised?: LockOptions["onCompromised"];
}

export interface FileLockRequest extends BaseLockRequest {
	type?: "file";
	lockfilePath?: string;
}

export interface DirectoryLockRequest extends BaseLockRequest {
	type: "directory";
	lockfileName?: string;
	lockfilePath?: string;
}

export type LockRequest = FileLockRequest | DirectoryLockRequest;

interface NormalizedLockRequest {
	path: string;
	options: LockOptions;
	sortKey: string;
}

export interface AtomicTextWriteOptions {
	lock?: LockRequest | null;
	executable?: boolean;
}

function createLockOptions(request: LockRequest, lockfilePath: string): LockOptions {
	const options: LockOptions = {
		stale: request.staleMs ?? DEFAULT_LOCK_STALE_MS,
		retries: request.retries ?? DEFAULT_LOCK_RETRIES,
		realpath: false,
		lockfilePath,
	};
	if (typeof request.onCompromised === "function") {
		options.onCompromised = request.onCompromised;
	}
	return options;
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export class LockedFileSystem {
	private async normalizeLockRequest(request: LockRequest): Promise<NormalizedLockRequest> {
		if (request.type === "directory") {
			await mkdir(request.path, { recursive: true });
			const lockfilePath = request.lockfilePath ?? join(request.path, request.lockfileName ?? ".lock");
			return {
				path: request.path,
				options: createLockOptions(request, lockfilePath),
				sortKey: lockfilePath,
			};
		}

		await mkdir(dirname(request.path), { recursive: true });
		const lockfilePath = request.lockfilePath ?? `${request.path}.lock`;
		return {
			path: request.path,
			options: createLockOptions(request, lockfilePath),
			sortKey: lockfilePath,
		};
	}

	async withLock<T>(request: LockRequest, operation: () => Promise<T>): Promise<T> {
		return await this.withLocks([request], operation);
	}

	async withLocks<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		const normalizedRequests = await Promise.all(
			requests.map(async (request) => await this.normalizeLockRequest(request)),
		);
		const orderedRequests = normalizedRequests
			.slice()
			.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
		const releases: Array<() => Promise<void>> = [];
		try {
			for (const request of orderedRequests) {
				releases.push(await lockfile.lock(request.path, request.options));
			}
			return await operation();
		} finally {
			for (const release of releases.reverse()) {
				await release();
			}
		}
	}

	async writeTextFileAtomic(path: string, content: string, options: AtomicTextWriteOptions = {}): Promise<void> {
		const lockRequest: LockRequest | null =
			options.lock === undefined
				? {
						path,
						type: "file" as const,
					}
				: options.lock;
		const writeOperation = async () => {
			const existingContent = await readFileIfExists(path);
			if (existingContent === content) {
				if (options.executable) {
					await chmod(path, 0o755);
				}
				return;
			}
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
			await writeFile(tempPath, content, "utf8");
			await rename(tempPath, path);
			if (options.executable) {
				await chmod(path, 0o755);
			}
		};
		if (lockRequest) {
			await this.withLock(lockRequest, writeOperation);
			return;
		}
		await writeOperation();
	}

	async writeJsonFileAtomic(
		path: string,
		payload: unknown,
		options: Omit<AtomicTextWriteOptions, "executable"> = {},
	): Promise<void> {
		await this.writeTextFileAtomic(path, JSON.stringify(payload, null, 2), options);
	}

	async removePath(path: string, options: { lock: LockRequest; recursive?: boolean; force?: boolean }): Promise<void> {
		await this.withLock(options.lock, async () => {
			await rm(path, {
				recursive: options.recursive,
				force: options.force,
			});
		});
	}
}

export const lockedFileSystem = new LockedFileSystem();

/**
 * Remove orphaned lock directories/files left behind by a process that exited
 * abruptly. proper-lockfile normally detects stale locks via mtime, but when a
 * crash burst triggers multiple pm2 restarts in quick succession, incoming
 * processes collide on fresh lock entries before the stale threshold expires.
 *
 * Call once on startup. Safe: if a peer actively holds a lock, its mtime will
 * be recent and we leave it alone.
 */
export async function reapStaleLocksIn(directory: string, staleMs: number = DEFAULT_LOCK_STALE_MS * 2): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch (error) {
		if (isEnoent(error)) {
			return;
		}
		throw error;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.endsWith(".lock")) {
			continue;
		}
		const lockPath = join(directory, entry);
		try {
			const info = await stat(lockPath);
			if (now - info.mtimeMs < staleMs) {
				continue;
			}
			await rm(lockPath, { recursive: true, force: true });
		} catch (error) {
			if (isEnoent(error)) {
			}
			// Best effort. If we cannot remove, the normal stale-break path
			// still applies.
		}
	}
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}
