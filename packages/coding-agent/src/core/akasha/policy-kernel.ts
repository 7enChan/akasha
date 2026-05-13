import type { AkashaEvent } from "./types.js";

export type AkashaPolicyDecisionAction = "allow" | "block" | "require_confirmation" | "require_validation" | "defer";

export type AkashaRuntimeActionType =
	| "tool_call"
	| "context_injection"
	| "temporal_recall"
	| "callback_dispatch"
	| "reflection"
	| "embedding_index"
	| "memory_projection"
	| "export"
	| "syscall";

export interface AkashaPolicyRule {
	id: string;
	description: string;
	severity: "info" | "warning" | "critical";
}

export interface AkashaValidationPlan {
	reason: string;
	recommendedCommands: string[];
	evidenceEventIds: string[];
}

export interface AkashaPolicyCallbackSchedule {
	callbackId: string;
	dueTime: string;
	summary: string;
	targetEventId?: string;
}

export interface AkashaPolicyEvaluationInput {
	actionType: AkashaRuntimeActionType | string;
	subject?: string;
	objectId?: string;
	payload?: Record<string, unknown>;
	evidenceEvents?: AkashaEvent[];
	rules?: AkashaPolicyRule[];
	now?: Date;
}

export interface AkashaRuntimePolicyAction {
	type: AkashaRuntimeActionType;
	subject?: string;
	objectId?: string;
	payload?: Record<string, unknown>;
	evidenceEvents?: AkashaEvent[];
	rules?: AkashaPolicyRule[];
	now?: Date;
}

export interface AkashaPolicyDecision {
	action: AkashaPolicyDecisionAction;
	ruleId?: string;
	severity: "info" | "warning" | "critical";
	reason: string;
	evidenceEventIds: string[];
	validationPlan?: AkashaValidationPlan;
	confirmationPrompt?: string;
	callback?: AkashaPolicyCallbackSchedule;
}

export const DEFAULT_AKASHA_RUNTIME_POLICY_RULES: AkashaPolicyRule[] = [
	{
		id: "max_context_injection_tokens",
		description: "Action context must stay within the configured token budget.",
		severity: "warning",
	},
	{
		id: "block_context_with_suppressed_sources",
		description: "Suppressed or redacted source events must not be injected into model context.",
		severity: "critical",
	},
	{
		id: "block_embedding_for_suppressed_source",
		description: "Suppressed or redacted source events must not be indexed into embeddings.",
		severity: "critical",
	},
	{
		id: "require_confirmation_for_export",
		description: "Akasha exports need explicit user confirmation.",
		severity: "warning",
	},
	{
		id: "block_callback_dispatch_if_target_suppressed",
		description: "Callbacks targeting suppressed events must not be dispatched.",
		severity: "critical",
	},
	{
		id: "block_syscall_without_source_event",
		description: "Time syscalls must identify their source event when running under strict protocol.",
		severity: "warning",
	},
];

export function evaluateAkashaPolicy(input: AkashaPolicyEvaluationInput): AkashaPolicyDecision {
	for (const rule of input.rules ?? []) {
		const decision = evaluateRule(input, rule);
		if (decision.action !== "allow") return decision;
	}
	return {
		action: "allow",
		severity: "info",
		reason: "No Akasha policy rule required intervention.",
		evidenceEventIds: [],
	};
}

export function evaluateAkashaRuntimePolicy(action: AkashaRuntimePolicyAction): AkashaPolicyDecision {
	return evaluateAkashaPolicy({
		actionType: action.type,
		subject: action.subject,
		objectId: action.objectId,
		payload: action.payload,
		evidenceEvents: action.evidenceEvents,
		rules: action.rules ?? DEFAULT_AKASHA_RUNTIME_POLICY_RULES,
		now: action.now,
	});
}

export function createPolicyEvaluatedPayload(
	input: AkashaPolicyEvaluationInput,
	decision: AkashaPolicyDecision,
): Record<string, unknown> {
	return {
		actionType: input.actionType,
		subject: input.subject,
		objectId: input.objectId,
		decision: decision.action,
		ruleId: decision.ruleId,
		severity: decision.severity,
		reason: decision.reason,
		evidenceEventIds: decision.evidenceEventIds,
		validationPlan: decision.validationPlan,
		confirmationPrompt: decision.confirmationPrompt,
		callback: decision.callback,
	};
}

function evaluateRule(input: AkashaPolicyEvaluationInput, rule: AkashaPolicyRule): AkashaPolicyDecision {
	if (rule.id === "destructive_command") {
		const label = typeof input.payload?.dangerousCommandLabel === "string" ? input.payload.dangerousCommandLabel : "";
		if (label) return decision("block", rule, `Akasha blocked a high-risk command before execution: ${label}`, []);
	}

	if (rule.id === "unverified_artifact_widening") {
		const unverified = input.evidenceEvents ?? [];
		if (unverified.length > 0) {
			const evidenceEventIds = unverified.map((event) => event.eventId);
			return {
				...decision(
					"require_validation",
					rule,
					"Akasha requires validation before editing another artifact because previous modifications remain unverified.",
					evidenceEventIds,
				),
				validationPlan: {
					reason: "Validate the current modified artifact chain before widening edits.",
					recommendedCommands: ["npm test", "npm run build"],
					evidenceEventIds,
				},
			};
		}
	}

	if (rule.id === "defer_until_callback") {
		const dueTime = typeof input.payload?.dueTime === "string" ? input.payload.dueTime : undefined;
		const summary = typeof input.payload?.summary === "string" ? input.payload.summary : undefined;
		if (dueTime && summary) {
			const now = input.now ?? new Date();
			return {
				...decision("defer", rule, `Akasha deferred this action until ${dueTime}: ${summary}`, []),
				callback: {
					callbackId: `policy:${input.subject ?? "action"}:${now.toISOString()}`,
					dueTime,
					summary,
					targetEventId:
						typeof input.payload?.targetEventId === "string" ? input.payload.targetEventId : undefined,
				},
			};
		}
	}

	if (rule.id === "max_context_injection_tokens" && input.actionType === "context_injection") {
		const estimate = numberPayload(input, "tokenEstimate");
		const max = numberPayload(input, "maxTokenEstimate");
		if (estimate !== undefined && max !== undefined && estimate > max) {
			return decision(
				"require_validation",
				rule,
				`Akasha action context token estimate ${estimate} exceeds policy budget ${max}.`,
				[],
			);
		}
	}

	if (rule.id === "block_context_with_suppressed_sources" && input.actionType === "context_injection") {
		const suppressed = stringArrayPayload(input, "suppressedSourceEventIds");
		if (suppressed.length > 0) {
			return decision(
				"block",
				rule,
				"Akasha blocked context injection from suppressed or redacted sources.",
				suppressed,
			);
		}
	}

	if (rule.id === "block_embedding_for_suppressed_source" && input.actionType === "embedding_index") {
		const suppressed = stringArrayPayload(input, "suppressedSourceEventIds");
		if (suppressed.length > 0) {
			return decision(
				"block",
				rule,
				"Akasha blocked embedding indexing for suppressed or redacted sources.",
				suppressed,
			);
		}
	}

	if (rule.id === "require_confirmation_for_export" && input.actionType === "export") {
		return {
			...decision("require_confirmation", rule, "Akasha requires confirmation before exporting time data.", []),
			confirmationPrompt: "Exporting Akasha time data can disclose local history. Confirm this export.",
		};
	}

	if (rule.id === "block_callback_dispatch_if_target_suppressed" && input.actionType === "callback_dispatch") {
		const evidenceEventIds = (input.evidenceEvents ?? []).map((event) => event.eventId);
		const targetSuppressed = input.payload?.targetSuppressed === true || evidenceEventIds.length > 0;
		if (targetSuppressed) {
			return decision(
				"block",
				rule,
				"Akasha blocked callback dispatch because its target is suppressed.",
				evidenceEventIds,
			);
		}
	}

	if (rule.id === "block_syscall_without_source_event" && input.actionType === "syscall") {
		const sourceEventIds = stringArrayPayload(input, "sourceEventIds");
		if (input.payload?.strict === true && sourceEventIds.length === 0) {
			return decision("block", rule, "Akasha strict protocol requires time syscalls to include sourceEventIds.", []);
		}
	}

	return {
		action: "allow",
		severity: "info",
		reason: "Rule did not match.",
		evidenceEventIds: [],
	};
}

function numberPayload(input: AkashaPolicyEvaluationInput, key: string): number | undefined {
	const value = input.payload?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayPayload(input: AkashaPolicyEvaluationInput, key: string): string[] {
	const value = input.payload?.[key];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function decision(
	action: AkashaPolicyDecisionAction,
	rule: AkashaPolicyRule,
	reason: string,
	evidenceEventIds: string[],
): AkashaPolicyDecision {
	return {
		action,
		ruleId: rule.id,
		severity: rule.severity,
		reason,
		evidenceEventIds,
	};
}
