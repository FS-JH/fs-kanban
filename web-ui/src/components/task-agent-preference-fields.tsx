import { ChevronDown } from "lucide-react";
import type { ReactElement } from "react";

import type { RuntimeConfigResponse } from "@/runtime/types";
import { cn } from "@/components/ui/cn";
import type {
	TaskAgentPreferenceValue,
	TaskFallbackAgentPreferenceValue,
} from "@/utils/task-agent-preferences";
import { getTaskAgentOptions, resolveTaskFallbackAgentId } from "@/utils/task-agent-preferences";

interface TaskAgentPreferenceFieldsProps {
	runtimeConfig: RuntimeConfigResponse | null;
	preferredValue: TaskAgentPreferenceValue;
	onPreferredChange: (value: TaskAgentPreferenceValue) => void;
	fallbackValue: TaskFallbackAgentPreferenceValue;
	onFallbackChange: (value: TaskFallbackAgentPreferenceValue) => void;
	disabled?: boolean;
}

function PreferenceSelect({
	id,
	value,
	onChange,
	options,
	disabled,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	options: Array<{ value: string; label: string; disabled?: boolean }>;
	disabled?: boolean;
}): ReactElement {
	return (
		<div className="relative min-w-0">
			<select
				id={id}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
				disabled={disabled}
				className={cn(
					"h-7 w-full appearance-none rounded-md border border-border-bright bg-surface-2 pl-2 pr-7 text-[12px] text-text-primary",
					"focus:border-border-focus focus:outline-none disabled:cursor-default disabled:opacity-40",
				)}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value} disabled={option.disabled}>
						{option.label}
					</option>
				))}
			</select>
			<ChevronDown
				size={14}
				className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-text-secondary"
			/>
		</div>
	);
}

export function TaskAgentPreferenceFields({
	runtimeConfig,
	preferredValue,
	onPreferredChange,
	fallbackValue,
	onFallbackChange,
	disabled = false,
}: TaskAgentPreferenceFieldsProps): ReactElement {
	const agentOptions = getTaskAgentOptions(runtimeConfig);
	const effectiveWorkspaceFallbackLabel = resolveTaskFallbackAgentId(
		{
			agentId: undefined,
			fallbackAgentId: undefined,
		},
		runtimeConfig,
	);
	const fallbackAgentLabel = agentOptions.find((agent) => agent.id === effectiveWorkspaceFallbackLabel)?.label ?? effectiveWorkspaceFallbackLabel;
	const preferredOptions = [
		{
			value: "inherit",
			label: `Workspace default (${runtimeConfig?.selectedAgentId ?? "not configured"})`,
		},
		...agentOptions.map((agent) => ({
			value: agent.id,
			label: agent.installed ? agent.label : `${agent.label} (not installed)`,
			disabled: !agent.installed,
		})),
	];
	const fallbackOptions = [
		{
			value: "inherit",
			label: effectiveWorkspaceFallbackLabel
				? `Workspace fallback (${fallbackAgentLabel})`
				: "Workspace fallback (none)",
		},
		{ value: "none", label: "No fallback" },
		...agentOptions.map((agent) => ({
			value: agent.id,
			label: agent.installed ? agent.label : `${agent.label} (not installed)`,
			disabled: !agent.installed,
		})),
	];

	return (
		<div className="flex flex-col gap-2">
			<div className="grid gap-2 sm:grid-cols-2">
				<div className="min-w-0">
					<span className="mb-1 block text-[11px] text-text-secondary">Preferred agent</span>
					<PreferenceSelect
						id="task-preferred-agent"
						value={preferredValue}
						onChange={(value) => onPreferredChange(value as TaskAgentPreferenceValue)}
						options={preferredOptions}
						disabled={disabled}
					/>
				</div>
				<div className="min-w-0">
					<span className="mb-1 block text-[11px] text-text-secondary">Retry fallback</span>
					<PreferenceSelect
						id="task-fallback-agent"
						value={fallbackValue}
						onChange={(value) => onFallbackChange(value as TaskFallbackAgentPreferenceValue)}
						options={fallbackOptions}
						disabled={disabled}
					/>
				</div>
			</div>
			<p className="m-0 text-[11px] text-text-tertiary">
				Preferred agent controls how this card starts. Retry fallback is suggested first when retrying a failed or interrupted task manually.
			</p>
		</div>
	);
}
