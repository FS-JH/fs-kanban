import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeApprovalRequest, RuntimeTaskHookActivity } from "../../../src/core/api-contract.js";
import { ApprovalAuditLog } from "../../../src/terminal/approval-audit-log.js";

function makeActivity(): RuntimeTaskHookActivity {
	return {
		activityText: "Waiting for approval",
		toolName: "read",
		toolInputSummary: "src/foo.ts",
		finalMessage: null,
		hookEventName: "permissionrequest",
		notificationType: "permission_prompt",
		source: "codex",
	};
}

function makeRequest(id: string): RuntimeApprovalRequest {
	return {
		id,
		taskId: "t1",
		workspaceId: "ws1",
		agentId: "codex",
		activity: makeActivity(),
		fingerprint: "fp",
		autoDecision: { shouldAutoApprove: true, reason: "read_only_tool" },
		status: "pending",
		createdAt: 1,
		decidedAt: null,
		decidedBy: null,
	};
}

describe("ApprovalAuditLog", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fs-audit-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("records queued and decided events that replay() returns in order", async () => {
		const log = new ApprovalAuditLog({ dir });
		const queued = makeRequest("r1");
		log.record({ type: "queued", request: queued });
		log.record({
			type: "decided",
			request: { ...queued, status: "user_approved", decidedAt: 2, decidedBy: "user" },
		});
		await log.close();
		const events = await ApprovalAuditLog.replay({ dir });
		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("queued");
		expect(events[1]?.type).toBe("decided");
		expect(events[1]?.request.status).toBe("user_approved");
	});

	it("rotates when file exceeds maxBytes, keeping older rotations within retention", async () => {
		const log = new ApprovalAuditLog({ dir, maxBytes: 256, retention: 2 });
		for (let i = 0; i < 30; i++) {
			log.record({ type: "queued", request: makeRequest(`r${i}`) });
		}
		await log.close();
		const files = await readdir(dir);
		const rotations = files.filter((f) => f.match(/^approvals\.\d+\.jsonl$/));
		expect(rotations.length).toBeGreaterThanOrEqual(1);
		expect(rotations.length).toBeLessThanOrEqual(2);
	});

	it("replays across rotated files in chronological order (oldest rotation first)", async () => {
		const log = new ApprovalAuditLog({ dir, maxBytes: 200, retention: 5 });
		for (let i = 0; i < 20; i++) {
			log.record({ type: "queued", request: makeRequest(`r${i}`) });
		}
		await log.close();
		const events = await ApprovalAuditLog.replay({ dir });
		const ids = events.map((e) => e.request.id);
		const sortedIds = [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
		expect(ids).toEqual(sortedIds);
	});

	it("replay returns empty when dir does not exist", async () => {
		const events = await ApprovalAuditLog.replay({ dir: join(dir, "nope") });
		expect(events).toEqual([]);
	});
});
