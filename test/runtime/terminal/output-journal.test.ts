import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutputJournal } from "../../../src/terminal/output-journal.js";

describe("OutputJournal", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fs-journal-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("encodes path-hostile task IDs into a safe filename basename", () => {
		const j = new OutputJournal({ dir, taskId: "__home_agent__:ws:codex" });
		const filename = basename(j.filePath());
		// basename must NOT contain colons (Windows-hostile)
		expect(filename).not.toMatch(/[:]/);
		expect(filename.endsWith(".jsonl")).toBe(true);
	});

	it("exposes a stable encodeSlug for filename generation", () => {
		const slug1 = OutputJournal.encodeSlug("__home_agent__:ws:codex");
		const slug2 = OutputJournal.encodeSlug("__home_agent__:ws:codex");
		expect(slug1).toBe(slug2);
		expect(slug1).not.toMatch(/[:]/);
	});

	it("serializes appends; reads back in order even when fired without await", async () => {
		const j = new OutputJournal({ dir, taskId: "t1" });
		j.append(Buffer.from("a"));
		j.append(Buffer.from("b"));
		j.append(Buffer.from("c"));
		await j.close();
		const lines = readFileSync(j.filePath(), "utf8").trim().split("\n");
		expect(lines.map((l) => JSON.parse(l).b64)).toEqual(
			["a", "b", "c"].map((s) => Buffer.from(s).toString("base64")),
		);
	});

	it("includes taskId in every record so on-disk file is self-describing", async () => {
		const j = new OutputJournal({ dir, taskId: "__home_agent__:ws:codex" });
		j.append(Buffer.from("x"));
		await j.close();
		const lines = readFileSync(j.filePath(), "utf8").trim().split("\n");
		expect(JSON.parse(lines[0]).taskId).toBe("__home_agent__:ws:codex");
	});

	it("rotates when file exceeds maxBytes; replay returns full ordered transcript", async () => {
		const j = new OutputJournal({ dir, taskId: "t-rot", maxBytes: 64 });
		for (let i = 0; i < 20; i++) j.append(Buffer.from("0123456789"));
		await j.close();
		const replay = await OutputJournal.replay({ dir, taskId: "t-rot" });
		expect(Buffer.concat(replay).toString()).toBe("0123456789".repeat(20));
	});

	it("preserves rotation counter across restarts so we don't overwrite", async () => {
		// (`readdir` is imported at the top of this test file from "node:fs/promises". No inline imports.)
		// First lifecycle: write enough to rotate once.
		const j1 = new OutputJournal({ dir, taskId: "t-restart", maxBytes: 32 });
		for (let i = 0; i < 5; i++) j1.append(Buffer.from("xxxxxxxxxxxx"));
		await j1.close();
		const after1 = await readdir(dir);
		expect(after1.some((f) => f.match(/\.1\.jsonl$/))).toBe(true);

		// Second lifecycle: same taskId.
		const j2 = new OutputJournal({ dir, taskId: "t-restart", maxBytes: 32 });
		for (let i = 0; i < 5; i++) j2.append(Buffer.from("yyyyyyyyyyyy"));
		await j2.close();
		const after2 = await readdir(dir);
		expect(after2.some((f) => f.match(/\.2\.jsonl$/))).toBe(true);

		// And replay returns ALL data ordered correctly.
		const replay = await OutputJournal.replay({ dir, taskId: "t-restart" });
		const text = Buffer.concat(replay).toString();
		expect(text.startsWith("xxxxxxxxxxxx")).toBe(true);
		expect(text.endsWith("yyyyyyyyyyyy")).toBe(true);
	});

	it("rotates correctly after a restart that left the base file with existing bytes", async () => {
		// Lifecycle 1: write enough to fill the base but NOT trigger rotation.
		const j1 = new OutputJournal({ dir, taskId: "t-bytes", maxBytes: 200 });
		for (let i = 0; i < 4; i++) j1.append(Buffer.from("xxxxxxxxxxxxxxx"));
		await j1.close();
		// Lifecycle 2: small extra appends should now push past maxBytes because
		// the journal accounts for existing on-disk bytes.
		const j2 = new OutputJournal({ dir, taskId: "t-bytes", maxBytes: 200 });
		for (let i = 0; i < 6; i++) j2.append(Buffer.from("xxxxxxxxxxxxxxx"));
		await j2.close();
		const after = await readdir(dir);
		expect(after.some((f) => f.match(/\.1\.jsonl$/))).toBe(true);
	});

	it("isolates same taskId across different workspace dirs", async () => {
		const wsA = join(dir, "ws-a");
		const wsB = join(dir, "ws-b");
		const ja = new OutputJournal({ dir: wsA, taskId: "task-1" });
		const jb = new OutputJournal({ dir: wsB, taskId: "task-1" });
		ja.append(Buffer.from("from-a"));
		jb.append(Buffer.from("from-b"));
		await ja.close();
		await jb.close();
		const replayA = Buffer.concat(await OutputJournal.replay({ dir: wsA, taskId: "task-1" })).toString();
		const replayB = Buffer.concat(await OutputJournal.replay({ dir: wsB, taskId: "task-1" })).toString();
		expect(replayA).toBe("from-a");
		expect(replayB).toBe("from-b");
	});

	it("close() awaits all in-flight appends", async () => {
		const j = new OutputJournal({ dir, taskId: "t-close" });
		j.append(Buffer.from("a"));
		j.append(Buffer.from("b"));
		await j.close();
		const replay = await OutputJournal.replay({ dir, taskId: "t-close" });
		expect(Buffer.concat(replay).toString()).toBe("ab");
	});
});
