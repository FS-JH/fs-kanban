import { Check, ChevronDown, ChevronRight, ShieldCheck, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeApprovalRequest } from "@/runtime/types";

interface SupervisorPanelProps {
	pending: readonly RuntimeApprovalRequest[];
	recent: readonly RuntimeApprovalRequest[];
	onDecide: (requestId: string, decision: "approved" | "denied") => Promise<void>;
}

const STATUS_LABEL: Record<RuntimeApprovalRequest["status"], string> = {
	pending: "Pending",
	auto_approved: "Auto-approved",
	auto_denied: "Auto-denied",
	user_approved: "Approved",
	user_denied: "Denied",
	timed_out: "Timed out",
};

function statusToneClass(status: RuntimeApprovalRequest["status"]): string {
	if (status === "pending") return "text-status-orange";
	if (status === "user_approved" || status === "auto_approved") return "text-status-green";
	if (status === "user_denied" || status === "auto_denied" || status === "timed_out") return "text-status-red";
	return "text-text-secondary";
}

function summarizeActivity(request: RuntimeApprovalRequest): string {
	const tool = request.activity.toolName?.trim();
	const input = request.activity.toolInputSummary?.trim();
	if (tool && input) {
		return `${tool} → ${input.length > 200 ? `${input.slice(0, 200)}…` : input}`;
	}
	if (tool) return tool;
	if (input) return input.length > 200 ? `${input.slice(0, 200)}…` : input;
	return request.activity.activityText ?? "Unknown action";
}

function formatRelative(timestamp: number | null): string {
	if (timestamp === null) return "";
	const delta = Date.now() - timestamp;
	if (delta < 60_000) return `${Math.max(1, Math.round(delta / 1000))}s ago`;
	if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
	if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
	return new Date(timestamp).toLocaleString();
}

interface ApprovalRowProps {
	request: RuntimeApprovalRequest;
	onApprove?: () => void;
	onDeny?: () => void;
	disabled?: boolean;
}

function ApprovalRow({ request, onApprove, onDeny, disabled }: ApprovalRowProps): JSX.Element {
	const tone = statusToneClass(request.status);
	const summary = summarizeActivity(request);
	const ageLabel = formatRelative(request.status === "pending" ? request.createdAt : request.decidedAt);
	return (
		<div className="bg-surface-2 rounded-md border border-border p-3 flex flex-col gap-2">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 min-w-0">
					<span className={cn("text-xs font-medium uppercase tracking-wide", tone)}>
						{STATUS_LABEL[request.status]}
					</span>
					{request.agentId ? (
						<span className="text-xs text-text-secondary uppercase">{request.agentId}</span>
					) : null}
					<span className="text-xs text-text-tertiary">{ageLabel}</span>
				</div>
				{onApprove && onDeny ? (
					<div className="flex items-center gap-2 shrink-0">
						<Tooltip content="Approve and let the agent proceed">
							<Button
								icon={<Check size={14} />}
								variant="primary"
								size="sm"
								onClick={onApprove}
								disabled={disabled}
								aria-label="Approve request"
							>
								Approve
							</Button>
						</Tooltip>
						<Tooltip content="Deny and instruct the agent to back off">
							<Button
								icon={<X size={14} />}
								variant="danger"
								size="sm"
								onClick={onDeny}
								disabled={disabled}
								aria-label="Deny request"
							>
								Deny
							</Button>
						</Tooltip>
					</div>
				) : null}
			</div>
			<div className="text-sm text-text-primary break-words">{summary}</div>
			<div className="text-xs text-text-secondary">
				Auto-policy: {request.autoDecision.shouldAutoApprove ? "would auto-approve" : "needs review"} — reason{" "}
				<code>{request.autoDecision.reason}</code>
			</div>
		</div>
	);
}

export function SupervisorPanel({ pending, recent, onDecide }: SupervisorPanelProps): JSX.Element {
	const [busyById, setBusyById] = useState<Record<string, boolean>>({});
	const [historyOpen, setHistoryOpen] = useState(false);

	const decide = async (requestId: string, decision: "approved" | "denied"): Promise<void> => {
		setBusyById((prev) => ({ ...prev, [requestId]: true }));
		try {
			await onDecide(requestId, decision);
		} finally {
			setBusyById((prev) => {
				const { [requestId]: _omit, ...rest } = prev;
				return rest;
			});
		}
	};

	return (
		<aside className="bg-surface-1 rounded-lg p-4 flex flex-col gap-4 min-w-0">
			<header className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<ShieldCheck size={18} className="text-text-primary" />
					<h2 className="text-sm font-semibold text-text-primary">Supervisor</h2>
					<span className="text-xs text-text-secondary">{pending.length} pending</span>
				</div>
			</header>
			{pending.length === 0 ? (
				<div className="text-sm text-text-secondary py-2">No pending approvals.</div>
			) : (
				<div className="flex flex-col gap-2">
					{pending.map((request) => (
						<ApprovalRow
							key={request.id}
							request={request}
							onApprove={() => void decide(request.id, "approved")}
							onDeny={() => void decide(request.id, "denied")}
							disabled={busyById[request.id] === true}
						/>
					))}
				</div>
			)}
			<div>
				<button
					type="button"
					onClick={() => setHistoryOpen((prev) => !prev)}
					className="flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary"
					aria-expanded={historyOpen}
				>
					{historyOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
					Recent decisions ({recent.length})
				</button>
				{historyOpen ? (
					<div className="flex flex-col gap-2 pt-2">
						{recent.length === 0 ? (
							<div className="text-xs text-text-tertiary py-2">No recent decisions.</div>
						) : (
							recent.map((request) => <ApprovalRow key={request.id} request={request} />)
						)}
					</div>
				) : null}
			</div>
		</aside>
	);
}
