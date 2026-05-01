import { randomUUID } from "node:crypto";

import type {
	RuntimeAgentId,
	RuntimeApprovalDecision,
	RuntimeApprovalRequest,
	RuntimeTaskHookActivity,
} from "../core/api-contract.js";

import {
	buildHookActivityFingerprint,
	evaluateSupervisedApproval,
	type SupervisedApprovalDecision,
} from "./agent-approval-policy.js";

export type SupervisorApprovalQueueEvent =
	| { type: "queued"; request: RuntimeApprovalRequest }
	| { type: "decided"; request: RuntimeApprovalRequest };

export interface EnqueueApprovalInput {
	taskId: string;
	workspaceId: string;
	agentId: RuntimeAgentId | null;
	activity: RuntimeTaskHookActivity;
}

export interface SupervisorApprovalQueueOptions {
	recentLimit?: number;
}

const DEFAULT_RECENT_LIMIT = 100;

function autoDecisionFromPolicy(decision: SupervisedApprovalDecision): {
	shouldAutoApprove: boolean;
	reason: string;
} {
	return {
		shouldAutoApprove: decision.shouldAutoApprove,
		reason: decision.reason,
	};
}

/**
 * In-memory queue for supervisor approval requests.
 *
 * Idempotency rule: while a request is pending, enqueueing the same
 * (taskId, fingerprint) returns the existing record. After a request is
 * decided, the same fingerprint may re-enqueue (the agent might prompt
 * again later).
 */
export class SupervisorApprovalQueue {
	private readonly entries = new Map<string, RuntimeApprovalRequest>();
	private readonly listeners = new Set<(event: SupervisorApprovalQueueEvent) => void>();
	private readonly recentLimit: number;

	constructor(options: SupervisorApprovalQueueOptions = {}) {
		this.recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
	}

	enqueue(input: EnqueueApprovalInput): RuntimeApprovalRequest {
		const fingerprint = buildHookActivityFingerprint(input.activity);
		const existing = this.findPendingByFingerprint(input.workspaceId, input.taskId, fingerprint);
		if (existing) {
			return existing;
		}
		const policy = evaluateSupervisedApproval(input.activity);
		const request: RuntimeApprovalRequest = {
			id: randomUUID(),
			taskId: input.taskId,
			workspaceId: input.workspaceId,
			agentId: input.agentId,
			activity: input.activity as RuntimeTaskHookActivity,
			fingerprint,
			autoDecision: autoDecisionFromPolicy(policy),
			status: "pending",
			createdAt: Date.now(),
			decidedAt: null,
			decidedBy: null,
		};
		this.entries.set(request.id, request);
		this.emit({ type: "queued", request });
		return request;
	}

	/**
	 * Apply a decision to a request. No-op if request does not exist or
	 * is already non-pending.
	 */
	decide(
		id: string,
		status: Exclude<RuntimeApprovalDecision, "pending">,
		decidedBy: "policy" | "user",
	): RuntimeApprovalRequest | null {
		const existing = this.entries.get(id);
		if (!existing) {
			return null;
		}
		if (existing.status !== "pending") {
			return existing;
		}
		const updated: RuntimeApprovalRequest = {
			...existing,
			status,
			decidedAt: Date.now(),
			decidedBy,
		};
		this.entries.set(id, updated);
		this.emit({ type: "decided", request: updated });
		this.pruneRecent();
		return updated;
	}

	get(id: string): RuntimeApprovalRequest | null {
		return this.entries.get(id) ?? null;
	}

	pending(): readonly RuntimeApprovalRequest[] {
		return Array.from(this.entries.values())
			.filter((entry) => entry.status === "pending")
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	recent(limit?: number): readonly RuntimeApprovalRequest[] {
		const decided = Array.from(this.entries.values())
			.filter((entry) => entry.status !== "pending")
			.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
		const cap = limit ?? this.recentLimit;
		return decided.slice(0, cap);
	}

	byTask(taskId: string): readonly RuntimeApprovalRequest[] {
		return Array.from(this.entries.values())
			.filter((entry) => entry.taskId === taskId)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	byWorkspace(workspaceId: string): readonly RuntimeApprovalRequest[] {
		return Array.from(this.entries.values())
			.filter((entry) => entry.workspaceId === workspaceId)
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	/**
	 * Cancel every pending request for a (workspaceId, taskId) pair by transitioning
	 * it to "timed_out". Called when a session exits / stops / is disposed so the
	 * Supervisor panel does not show permanently pending requests against a dead
	 * session. workspaceId is REQUIRED — the same taskId may be live in another
	 * workspace and must not be cancelled.
	 */
	cancelPendingForTask(workspaceId: string | null, taskId: string): readonly RuntimeApprovalRequest[] {
		if (!workspaceId) return [];
		const cancelled: RuntimeApprovalRequest[] = [];
		for (const entry of this.entries.values()) {
			if (entry.status !== "pending") continue;
			if (entry.workspaceId !== workspaceId) continue;
			if (entry.taskId !== taskId) continue;
			const updated = this.decide(entry.id, "timed_out", "policy");
			if (updated) cancelled.push(updated);
		}
		return cancelled;
	}

	/**
	 * Cancel every pending request across an entire workspace (e.g. on workspace
	 * dispose / project removal).
	 */
	cancelPendingForWorkspace(workspaceId: string): readonly RuntimeApprovalRequest[] {
		const cancelled: RuntimeApprovalRequest[] = [];
		for (const entry of this.entries.values()) {
			if (entry.status !== "pending") continue;
			if (entry.workspaceId !== workspaceId) continue;
			const updated = this.decide(entry.id, "timed_out", "policy");
			if (updated) cancelled.push(updated);
		}
		return cancelled;
	}

	subscribe(listener: (event: SupervisorApprovalQueueEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Reseed the queue from a list of historical events (e.g. on audit-log replay).
	 * No listeners are notified during reseed.
	 */
	rehydrate(events: readonly SupervisorApprovalQueueEvent[]): void {
		for (const event of events) {
			if (event.type === "queued") {
				if (!this.entries.has(event.request.id)) {
					this.entries.set(event.request.id, event.request);
				}
				continue;
			}
			const existing = this.entries.get(event.request.id);
			if (existing) {
				this.entries.set(event.request.id, { ...existing, ...event.request });
				continue;
			}
			this.entries.set(event.request.id, event.request);
		}
		this.pruneRecent();
	}

	private findPendingByFingerprint(
		workspaceId: string,
		taskId: string,
		fingerprint: string,
	): RuntimeApprovalRequest | null {
		for (const entry of this.entries.values()) {
			if (entry.status !== "pending") continue;
			if (entry.workspaceId !== workspaceId) continue;
			if (entry.taskId !== taskId) continue;
			if (entry.fingerprint !== fingerprint) continue;
			return entry;
		}
		return null;
	}

	private emit(event: SupervisorApprovalQueueEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Listener errors must not break other listeners.
			}
		}
	}

	private pruneRecent(): void {
		// Keep at most recentLimit decided entries to bound memory growth.
		const decided = Array.from(this.entries.values())
			.filter((entry) => entry.status !== "pending")
			.sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0));
		while (decided.length > this.recentLimit) {
			const oldest = decided.shift();
			if (!oldest) break;
			this.entries.delete(oldest.id);
		}
	}
}
