import { LayoutGrid } from "lucide-react";

import { BoardCard } from "@/components/board-card";
import type { RuntimeAggregateBoardCard, RuntimeAggregateBoardData } from "@/runtime/types";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";
import { formatPathForDisplay } from "@/utils/path-display";

function toReviewWorkspaceSnapshot(card: RuntimeAggregateBoardCard): ReviewTaskWorkspaceSnapshot | null {
	const taskWorkspace = card.taskWorkspace;
	if (!taskWorkspace) {
		return null;
	}
	return {
		taskId: taskWorkspace.taskId,
		path: taskWorkspace.path,
		branch: taskWorkspace.branch,
		isDetached: taskWorkspace.isDetached,
		headCommit: taskWorkspace.headCommit,
		changedFiles: taskWorkspace.changedFiles,
		additions: taskWorkspace.additions,
		deletions: taskWorkspace.deletions,
	};
}

export function ActiveProjectsBoard({
	data,
	onCardSelect,
	onCommitTask,
	onOpenPrTask,
	onMoveToTrashTask,
	onCancelAutomaticTaskAction,
	commitTaskLoadingById,
	openPrTaskLoadingById,
	moveToTrashLoadingById,
}: {
	data: RuntimeAggregateBoardData | null;
	onCardSelect: (card: RuntimeAggregateBoardCard) => void;
	onCommitTask: (card: RuntimeAggregateBoardCard) => void;
	onOpenPrTask: (card: RuntimeAggregateBoardCard) => void;
	onMoveToTrashTask: (card: RuntimeAggregateBoardCard) => void;
	onCancelAutomaticTaskAction: (card: RuntimeAggregateBoardCard) => void;
	commitTaskLoadingById: Record<string, boolean>;
	openPrTaskLoadingById: Record<string, boolean>;
	moveToTrashLoadingById: Record<string, boolean>;
}): React.ReactElement {
	if (!data || data.columns.every((column) => column.cards.length === 0)) {
		return (
			<div className="flex flex-1 min-h-0 items-center justify-center bg-surface-0 p-6">
				<div className="flex flex-col items-center justify-center gap-3 text-text-tertiary">
					<LayoutGrid size={42} strokeWidth={1.5} />
					<h3 className="text-sm font-semibold text-text-primary">No active work</h3>
					<p className="text-[13px] text-text-secondary">In-progress and review tasks across projects will appear here.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-1 min-h-0 min-w-0 gap-3 bg-surface-0 p-3">
			{data.columns.map((column) => (
				<section
					key={column.id}
					className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-surface-1"
				>
					<div className="flex h-10 items-center justify-between px-3">
						<div className="flex items-center gap-2">
							<span className="font-semibold text-sm">{column.title}</span>
							<span className="text-xs text-text-secondary">{column.cards.length}</span>
						</div>
					</div>
					<div className="kb-column-cards">
						{column.cards.map((card, index) => (
							<BoardCard
								key={card.key}
								card={card.card}
								index={index}
								columnId={column.id}
								sessionSummary={card.session ?? undefined}
								onCommit={() => onCommitTask(card)}
								onOpenPr={() => onOpenPrTask(card)}
								onMoveToTrash={() => onMoveToTrashTask(card)}
								onCancelAutomaticAction={() => onCancelAutomaticTaskAction(card)}
								isCommitLoading={commitTaskLoadingById[card.key] ?? false}
								isOpenPrLoading={openPrTaskLoadingById[card.key] ?? false}
								isMoveToTrashLoading={moveToTrashLoadingById[card.key] ?? false}
								workspacePath={card.projectPath}
								projectLabel={card.projectName}
								projectSubtitle={formatPathForDisplay(card.projectPath)}
								reviewWorkspaceSnapshotOverride={toReviewWorkspaceSnapshot(card)}
								isDraggable={false}
								onClick={() => onCardSelect(card)}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	);
}
