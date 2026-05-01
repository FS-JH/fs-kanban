import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskHookActivity } from "../../../src/core/api-contract.js";
import { SupervisorApprovalQueue } from "../../../src/terminal/supervisor-approval-queue.js";

function makeActivity(overrides: Partial<RuntimeTaskHookActivity> = {}): RuntimeTaskHookActivity {
	return {
		activityText: "Waiting for approval",
		toolName: "read",
		toolInputSummary: "src/foo.ts",
		finalMessage: null,
		hookEventName: "permissionrequest",
		notificationType: "permission_prompt",
		source: "codex",
		...overrides,
	};
}

describe("SupervisorApprovalQueue", () => {
	it("enqueues a new request and emits a queued event", () => {
		const queue = new SupervisorApprovalQueue();
		const listener = vi.fn();
		queue.subscribe(listener);
		const request = queue.enqueue({
			taskId: "t1",
			workspaceId: "ws1",
			agentId: "codex",
			activity: makeActivity(),
		});
		expect(request.status).toBe("pending");
		expect(request.taskId).toBe("t1");
		expect(request.workspaceId).toBe("ws1");
		expect(request.autoDecision.shouldAutoApprove).toBe(true);
		expect(listener).toHaveBeenCalledWith({ type: "queued", request });
	});

	it("dedupes by (taskId, fingerprint) while a request is pending", () => {
		const queue = new SupervisorApprovalQueue();
		const a = queue.enqueue({ taskId: "t1", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		const b = queue.enqueue({ taskId: "t1", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		expect(b.id).toBe(a.id);
	});

	it("allows re-enqueue after a previous request was decided", () => {
		const queue = new SupervisorApprovalQueue();
		const a = queue.enqueue({ taskId: "t1", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		queue.decide(a.id, "user_approved", "user");
		const c = queue.enqueue({ taskId: "t1", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		expect(c.id).not.toBe(a.id);
		expect(c.status).toBe("pending");
	});

	it("decide is idempotent on already-decided requests", () => {
		const queue = new SupervisorApprovalQueue();
		const a = queue.enqueue({ taskId: "t1", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		const first = queue.decide(a.id, "user_approved", "user");
		const second = queue.decide(a.id, "user_denied", "user");
		expect(first?.status).toBe("user_approved");
		expect(second?.status).toBe("user_approved");
	});

	it("decide returns null for unknown id", () => {
		const queue = new SupervisorApprovalQueue();
		expect(queue.decide("missing", "user_approved", "user")).toBeNull();
	});

	it("notifies listeners on enqueue and decide", () => {
		const queue = new SupervisorApprovalQueue();
		const listener = vi.fn();
		queue.subscribe(listener);
		const a = queue.enqueue({ taskId: "t1", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		queue.decide(a.id, "auto_approved", "policy");
		expect(listener).toHaveBeenCalledTimes(2);
		expect(listener.mock.calls[0]?.[0]?.type).toBe("queued");
		expect(listener.mock.calls[1]?.[0]?.type).toBe("decided");
	});

	it("byTask and byWorkspace return ordered results", () => {
		const queue = new SupervisorApprovalQueue();
		const a = queue.enqueue({
			taskId: "t1",
			workspaceId: "ws1",
			agentId: "codex",
			activity: makeActivity({ toolName: "read", toolInputSummary: "a" }),
		});
		// dedupe on same fingerprint, so vary the activity to get a separate request
		const b = queue.enqueue({
			taskId: "t1",
			workspaceId: "ws1",
			agentId: "codex",
			activity: makeActivity({ toolName: "read", toolInputSummary: "b" }),
		});
		const byT = queue.byTask("t1");
		expect(byT.map((r) => r.id)).toEqual([a.id, b.id]);
		const byW = queue.byWorkspace("ws1");
		expect(byW.map((r) => r.id)).toEqual([a.id, b.id]);
	});

	it("dedupe is workspace-scoped: same taskId+fingerprint in another workspace creates a new request", () => {
		const queue = new SupervisorApprovalQueue();
		const a = queue.enqueue({ taskId: "t1", workspaceId: "ws-a", agentId: "codex", activity: makeActivity() });
		const b = queue.enqueue({ taskId: "t1", workspaceId: "ws-b", agentId: "codex", activity: makeActivity() });
		expect(b.id).not.toBe(a.id);
		expect(b.workspaceId).toBe("ws-b");
	});

	it("cancelPendingForTask transitions all pending requests on that (workspace, task) to timed_out", () => {
		const queue = new SupervisorApprovalQueue();
		const a = queue.enqueue({ taskId: "t1", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		const b = queue.enqueue({
			taskId: "t1",
			workspaceId: "ws1",
			agentId: "codex",
			activity: makeActivity({ toolName: "read", toolInputSummary: "other" }),
		});
		const c = queue.enqueue({ taskId: "t-other", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		// Same taskId but different workspace must NOT be cancelled.
		const d = queue.enqueue({ taskId: "t1", workspaceId: "ws-other", agentId: "codex", activity: makeActivity() });
		const cancelled = queue.cancelPendingForTask("ws1", "t1");
		expect(cancelled).toHaveLength(2);
		expect(queue.get(a.id)?.status).toBe("timed_out");
		expect(queue.get(b.id)?.status).toBe("timed_out");
		expect(queue.get(c.id)?.status).toBe("pending");
		expect(queue.get(d.id)?.status).toBe("pending");
	});

	it("cancelPendingForTask is a no-op when workspaceId is null", () => {
		const queue = new SupervisorApprovalQueue();
		const a = queue.enqueue({ taskId: "t1", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		const cancelled = queue.cancelPendingForTask(null, "t1");
		expect(cancelled).toHaveLength(0);
		expect(queue.get(a.id)?.status).toBe("pending");
	});

	it("cancelPendingForWorkspace transitions all pending requests in that workspace to timed_out", () => {
		const queue = new SupervisorApprovalQueue();
		const a = queue.enqueue({ taskId: "t1", workspaceId: "ws-a", agentId: "codex", activity: makeActivity() });
		const b = queue.enqueue({ taskId: "t2", workspaceId: "ws-a", agentId: "codex", activity: makeActivity() });
		const c = queue.enqueue({ taskId: "t1", workspaceId: "ws-b", agentId: "codex", activity: makeActivity() });
		const cancelled = queue.cancelPendingForWorkspace("ws-a");
		expect(cancelled).toHaveLength(2);
		expect(queue.get(a.id)?.status).toBe("timed_out");
		expect(queue.get(b.id)?.status).toBe("timed_out");
		expect(queue.get(c.id)?.status).toBe("pending");
	});

	it("rehydrate replays queued and decided events", () => {
		const queue = new SupervisorApprovalQueue();
		const initial = new SupervisorApprovalQueue();
		const a = initial.enqueue({ taskId: "t1", workspaceId: "ws1", agentId: "codex", activity: makeActivity() });
		initial.decide(a.id, "user_approved", "user");
		const updated = initial.get(a.id);
		expect(updated).not.toBeNull();
		queue.rehydrate([
			{ type: "queued", request: a },
			...(updated ? [{ type: "decided" as const, request: updated }] : []),
		]);
		const restored = queue.get(a.id);
		expect(restored?.status).toBe("user_approved");
		expect(restored?.decidedBy).toBe("user");
	});
});
