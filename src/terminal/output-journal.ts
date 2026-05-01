import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

interface JournalOptions {
	dir: string;
	taskId: string;
	maxBytes?: number;
}

interface JournalRecord {
	seq: number;
	ts: number;
	taskId: string;
	b64: string;
}

export class OutputJournal {
	private writeChain: Promise<void> = Promise.resolve();
	private seq = 0;
	private bytesInFile = 0;
	private stream: WriteStream | null = null;
	private fileSlug: string;
	private rotation = 0;

	constructor(private readonly opts: JournalOptions) {
		this.fileSlug = OutputJournal.encodeSlug(opts.taskId);
	}

	/** Initialize rotation counter from existing files so we don't overwrite after restart. */
	private async initRotationCounter(): Promise<void> {
		if (this.rotation > 0) return;
		try {
			const files = await readdir(this.opts.dir);
			const max = files
				.map((f) => (f.startsWith(this.fileSlug) ? parseRotation(f) : 0))
				.filter((n) => Number.isFinite(n))
				.reduce((a, b) => Math.max(a, b), 0);
			this.rotation = max;
		} catch {
			// dir doesn't exist yet - that's fine; rotation stays 0
		}
	}

	static encodeSlug(taskId: string): string {
		// Replace any non-[A-Za-z0-9_-] with underscore, then append a short stable hash for collision safety
		const safe = taskId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
		const hash = createHash("sha1").update(taskId).digest("hex").slice(0, 8);
		return `${safe}-${hash}`;
	}

	filePath(): string {
		return join(this.opts.dir, `${this.fileSlug}.jsonl`);
	}

	append(chunk: Buffer): void {
		this.writeChain = this.writeChain.then(() => this.appendInternal(chunk));
		// intentionally not awaiting - caller should be PTY hot path
	}

	private async appendInternal(chunk: Buffer): Promise<void> {
		await mkdir(this.opts.dir, { recursive: true });
		await this.initRotationCounter();
		if (!this.stream) {
			// Account for bytes already on disk so post-restart appends rotate at the right time.
			try {
				const existing = await stat(this.filePath());
				this.bytesInFile = existing.size;
			} catch {
				this.bytesInFile = 0;
			}
			this.stream = createWriteStream(this.filePath(), { flags: "a" });
		}
		this.seq += 1;
		const rec: JournalRecord = {
			seq: this.seq,
			ts: Date.now(),
			taskId: this.opts.taskId,
			b64: chunk.toString("base64"),
		};
		const line = `${JSON.stringify(rec)}\n`;
		this.bytesInFile += Buffer.byteLength(line);
		await new Promise<void>((resolve, reject) => this.stream?.write(line, (err) => (err ? reject(err) : resolve())));
		if (this.bytesInFile > (this.opts.maxBytes ?? 8 * 1024 * 1024)) {
			await this.rotate();
		}
	}

	private async rotate(): Promise<void> {
		if (!this.stream) return;
		await new Promise<void>((res) => this.stream?.end(res));
		this.rotation += 1;
		await rename(this.filePath(), join(this.opts.dir, `${this.fileSlug}.${this.rotation}.jsonl`));
		this.stream = null;
		this.bytesInFile = 0;
	}

	async close(): Promise<void> {
		await this.writeChain;
		if (this.stream) {
			await new Promise<void>((res) => this.stream?.end(res));
			this.stream = null;
		}
	}

	static async replay(opts: { dir: string; taskId: string }): Promise<readonly Buffer[]> {
		const slug = OutputJournal.encodeSlug(opts.taskId);
		let files: string[];
		try {
			files = (await readdir(opts.dir)).filter((f) => f.startsWith(slug));
		} catch {
			return [];
		}
		const ordered = files.sort((a, b) => {
			// base file last (no rotation suffix). Rotated files have .N.jsonl.
			const aN = parseRotation(a);
			const bN = parseRotation(b);
			return aN - bN;
		});
		const buffers: Buffer[] = [];
		for (const file of ordered) {
			const content = await readFile(join(opts.dir, file), "utf8");
			for (const line of content.split("\n")) {
				if (!line.trim()) continue;
				try {
					const rec = JSON.parse(line) as JournalRecord;
					buffers.push(Buffer.from(rec.b64, "base64"));
				} catch {
					// skip corrupt line
				}
			}
		}
		return buffers;
	}

	/** Permanently remove all journal files (base + rotated) for a task. */
	static async deleteForTask(opts: { dir: string; taskId: string }): Promise<void> {
		const slug = OutputJournal.encodeSlug(opts.taskId);
		let files: string[];
		try {
			files = (await readdir(opts.dir)).filter((f) => f.startsWith(slug));
		} catch {
			return;
		}
		await Promise.all(
			files.map(async (file) => {
				try {
					await unlink(join(opts.dir, file));
				} catch {
					// ignore unlink errors
				}
			}),
		);
	}
}

function parseRotation(filename: string): number {
	const m = filename.match(/\.(\d+)\.jsonl$/);
	if (m) return Number(m[1]);
	return Number.POSITIVE_INFINITY; // base file sorts last, most recent writes last
}
