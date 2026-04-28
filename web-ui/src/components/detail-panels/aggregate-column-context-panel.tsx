import { LayoutGrid } from "lucide-react";
import { useEffect, useRef } from "react";

import { BoardCard } from "@/components/board-card";
import type { RuntimeAggregateBoardCard, RuntimeAggregateBoardData } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

export function AggregateColumnContextPanel({
	data,
	selectedCardKey,
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
	selectedCardKey: string | null;
	onCardSelect: (card: RuntimeAggregateBoardCard) => void;
	onCommitTask: (card: RuntimeAggregateBoardCard) => void;
	onOpenPrTask: (card: RuntimeAggregateBoardCard) => void;
	onMoveToTrashTask: (card: RuntimeAggregateBoardCard) => void;
	onCancelAutomaticTaskAction: (card: RuntimeAggregateBoardCard) => void;
	commitTaskLoadingById: Record<string, boolean>;
	openPrTaskLoadingById: Record<string, boolean>;
	moveToTrashLoadingById: Record<string, boolean>;
}): React.ReactElement {
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	const hasCards = data?.columns.some((column) => column.cards.length > 0) ?? false;

	useEffect(() => {
		const scrollContainer = scrollContainerRef.current;
		if (!scrollContainer || !selectedCardKey) {
			return;
		}
		const escapedCardKey = selectedCardKey.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
		const selectedCardElement = scrollContainer.querySelector<HTMLElement>(`[data-aggregate-card-key="${escapedCardKey}"]`);
		if (!selectedCardElement) {
			return;
		}

		const frameId = window.requestAnimationFrame(() => {
			selectedCardElement.scrollIntoView({
				block: "center",
				inline: "nearest",
			});
		});
		return () => {
			window.cancelAnimationFrame(frameId);
		};
	}, [selectedCardKey]);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				width: "20%",
				minHeight: 0,
				overflow: "hidden",
				background: "var(--color-surface-0)",
				borderRight: "1px solid var(--color-divider)",
			}}
		>
			<div
				ref={scrollContainerRef}
				className="flex flex-col gap-2 p-2"
				style={{
					flex: "1 1 0",
					minHeight: 0,
					overflowY: "auto",
					overscrollBehavior: "contain",
					overflowAnchor: "none",
				}}
			>
				{!data || !hasCards ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-tertiary">
						<LayoutGrid size={36} strokeWidth={1.5} />
						<div className="text-xs font-semibold text-text-secondary">No active work</div>
					</div>
				) : (
					data.columns.map((column) => (
						<section key={column.id} className="shrink-0 rounded-lg bg-surface-1">
							<div className="flex h-10 items-center px-3">
								<div className="flex min-w-0 items-center gap-2">
									<span className="truncate text-[13px] font-semibold">{column.title}</span>
									<span className="shrink-0 text-[11px] text-text-secondary">{column.cards.length}</span>
								</div>
							</div>
							<div className="flex flex-col p-2">
								{column.cards.length === 0 ? (
									<div className="flex items-center justify-center py-4 text-text-tertiary text-xs">Empty</div>
								) : (
									column.cards.map((card, index) => (
										<div key={card.key} className="mb-2 last:mb-0" data-aggregate-card-key={card.key}>
											<div className="mb-1 flex min-w-0 items-center gap-1.5 px-1 text-[10px] text-text-tertiary">
												<span className="truncate font-medium text-text-secondary">{card.projectName}</span>
												<span className="shrink-0">|</span>
												<span className="truncate font-mono">{formatPathForDisplay(card.projectPath)}</span>
											</div>
											<BoardCard
												card={card.card}
												index={index}
												columnId={column.id}
												sessionSummary={card.session ?? undefined}
												selected={card.key === selectedCardKey}
												onCommit={() => onCommitTask(card)}
												onOpenPr={() => onOpenPrTask(card)}
												onMoveToTrash={() => onMoveToTrashTask(card)}
												onCancelAutomaticAction={() => onCancelAutomaticTaskAction(card)}
												isCommitLoading={commitTaskLoadingById[card.key] ?? false}
												isOpenPrLoading={openPrTaskLoadingById[card.key] ?? false}
												isMoveToTrashLoading={moveToTrashLoadingById[card.key] ?? false}
												isDraggable={false}
												onClick={() => onCardSelect(card)}
											/>
										</div>
									))
								)}
							</div>
						</section>
					))
				)}
			</div>
		</div>
	);
}
