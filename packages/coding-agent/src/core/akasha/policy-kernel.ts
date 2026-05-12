import type { AkashaEvent } from "./types.js";

export type AkashaPolicyDecisionAction = "allow" | "block" | "require_confirmation" | "require_validation" | "defer";

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
	actionType: string;
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

	return {
		action: "allow",
		severity: "info",
		reason: "Rule did not match.",
		evidenceEventIds: [],
	};
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
