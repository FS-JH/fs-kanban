import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
	type RuntimeApprovalRequest,
	runtimeApprovalRequestSchema,
} from "../core/api-contract.js";

import type { SupervisorApprovalQueueEvent } from "./supervisor-approval-queue.js";

const BASE_FILENAME = "approvals.jsonl";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_RETENTION = 5; // keep approvals.1.jsonl ... approvals.5.jsonl

interface AuditLogOptions {
	dir: string;
	maxBytes?: number;
	retention?: number;
}

interface QueuedRecord {
	kind: "queued";
	ts: number;
	request: RuntimeApprovalRequest;
}

interface DecidedRecord {
	kind: "decided";
	ts: number;
	request: RuntimeApprovalRequest;
}

type AuditRecord = QueuedRecord | DecidedRecord;

/**
 * Append-only JSONL audit log for supervisor approval events.
 * Records both `queued` and `decided` events so a runtime restart can fully
 * reconstruct the queue (including pending requests).
 *
 * Writes are serialized via an internal promise chain so PTY-fast-path callers
 * can fire-and-forget. `close()` awaits the chain and flushes the stream.
 */
export class ApprovalAuditLog {
	private writeChain: Promise<void> = Promise.resolve();
	private stream: WriteStream | null = null;
	private bytesInFile = 0;
	private readonly maxBytes: number;
	private readonly retention: number;
	private initialized = false;

	constructor(private readonly opts: AuditLogOptions) {
		this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		this.retention = opts.retention ?? DEFAULT_RETENTION;
	}

	filePath(): string {
		return join(this.opts.dir, BASE_FILENAME);
	}

	record(event: SupervisorApprovalQueueEvent): void {
		const payload: AuditRecord = {
			kind: event.type,
			ts: Date.now(),
			request: event.request,
		};
		this.writeChain = this.writeChain.then(() => this.appendInternal(payload));
	}

	private async appendInternal(record: AuditRecord): Promise<void> {
		await mkdir(this.opts.dir, { recursive: true });
		await this.ensureStream();
		const line = `${JSON.stringify(record)}\n`;
		this.bytesInFile += Buffer.byteLength(line);
		await new Promise<void>((resolve, reject) =>
			this.stream?.write(line, (err) => (err ? reject(err) : resolve())),
		);
		if (this.bytesInFile > this.maxBytes) {
			await this.rotate();
		}
	}

	private async ensureStream(): Promise<void> {
		if (this.stream) return;
		if (!this.initialized) {
			this.initialized = true;
			// Pick up size of existing base file so a restart-with-existing-rotations
			// ages the file out at the right time.
			try {
				const existing = await readFile(this.filePath());
				this.bytesInFile = existing.byteLength;
			} catch {
				this.bytesInFile = 0;
			}
		}
		this.stream = createWriteStream(this.filePath(), { flags: "a" });
	}

	private async rotate(): Promise<void> {
		if (!this.stream) return;
		await new Promise<void>((res) => this.stream?.end(res));
		this.stream = null;
		// Shift approvals.{N-1}.jsonl -> approvals.N.jsonl, approvals.{N-2}.jsonl -> approvals.{N-1}.jsonl, etc.
		// then approvals.jsonl -> approvals.1.jsonl. Drop approvals.{retention+1}.jsonl.
		for (let i = this.retention; i >= 1; i--) {
			const src = i === 1 ? this.filePath() : join(this.opts.dir, `approvals.${i - 1}.jsonl`);
			const dst = join(this.opts.dir, `approvals.${i}.jsonl`);
			try {
				if (i === this.retention) {
					await unlink(dst).catch(() => undefined);
				}
				await rename(src, dst);
			} catch {
				// missing intermediate files are fine
			}
		}
		this.bytesInFile = 0;
	}

	async close(): Promise<void> {
		await this.writeChain;
		if (this.stream) {
			await new Promise<void>((res) => this.stream?.end(res));
			this.stream = null;
		}
	}

	/**
	 * Replay all events in chronological order across rotated files
	 * (oldest rotation first, base file last).
	 */
	static async replay(opts: { dir: string; retention?: number }): Promise<readonly SupervisorApprovalQueueEvent[]> {
		const retention = opts.retention ?? DEFAULT_RETENTION;
		const files: string[] = [];
		try {
			const entries = await readdir(opts.dir);
			for (let i = retention; i >= 1; i--) {
				const candidate = `approvals.${i}.jsonl`;
				if (entries.includes(candidate)) files.push(candidate);
			}
			if (entries.includes(BASE_FILENAME)) files.push(BASE_FILENAME);
		} catch {
			return [];
		}

		const events: SupervisorApprovalQueueEvent[] = [];
		for (const file of files) {
			let content: string;
			try {
				content = await readFile(join(opts.dir, file), "utf8");
			} catch {
				continue;
			}
			for (const line of content.split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line) as { kind: unknown; request: unknown };
					if (parsed.kind !== "queued" && parsed.kind !== "decided") continue;
					const request = runtimeApprovalRequestSchema.parse(parsed.request);
					events.push({ type: parsed.kind, request });
				} catch {
					// skip corrupt lines
				}
			}
		}
		return events;
	}
}
