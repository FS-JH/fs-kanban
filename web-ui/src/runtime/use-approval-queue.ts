import { useCallback, useEffect } from "react";

import type { RuntimeApprovalRequest } from "@/runtime/types";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { ApprovalQueueState } from "@/runtime/use-runtime-state-stream";

export interface UseApprovalQueueResult {
	pending: readonly RuntimeApprovalRequest[];
	recent: readonly RuntimeApprovalRequest[];
	decide: (requestId: string, decision: "approved" | "denied") => Promise<void>;
}

export interface UseApprovalQueueInput {
	workspaceId: string | null;
	approvalQueueState: ApprovalQueueState;
	dispatchSeedApprovals: (input: ApprovalQueueState) => void;
}

export function useApprovalQueue({
	workspaceId,
	approvalQueueState,
	dispatchSeedApprovals,
}: UseApprovalQueueInput): UseApprovalQueueResult {
	useEffect(() => {
		if (!workspaceId) return;
		let cancelled = false;
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		void trpcClient.runtime.approvals.list
			.query({ workspaceId })
			.then((result) => {
				if (cancelled) return;
				dispatchSeedApprovals({
					pending: [...result.pending],
					recent: [...result.recent],
				});
			})
			.catch(() => {
				// Initial seed failed; live stream events will still populate state.
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, dispatchSeedApprovals]);

	const decide = useCallback(
		async (requestId: string, decision: "approved" | "denied"): Promise<void> => {
			if (!workspaceId) return;
			const trpcClient = getRuntimeTrpcClient(workspaceId);
			await trpcClient.runtime.approvals.decide.mutate({
				workspaceId,
				requestId,
				decision,
			});
		},
		[workspaceId],
	);

	return {
		pending: approvalQueueState.pending,
		recent: approvalQueueState.recent,
		decide,
	};
}
