import type { AkashaEvent } from "./types.js";

export type AkashaPolicyDecisionAction = "allow" | "block" | "require_confirmation" | "require_validation" | "defer";

export interface AkashaPolicyRule {
	id: string;
	description: string;
	severity: "info" | "warning" | "critical";
}

export interface AkashaPolicyEvaluationInput {
	actionType: string;
	subject?: string;
	objectId?: string;
	payload?: Record<string, unknown>;
	evidenceEvents?: AkashaEvent[];
	rules?: AkashaPolicyRule[];
}

export interface AkashaPolicyDecision {
	action: AkashaPolicyDecisionAction;
	ruleId?: string;
	severity: "info" | "warning" | "critical";
	reason: string;
	evidenceEventIds: string[];
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
			return decision(
				"require_validation",
				rule,
				"Akasha requires validation before editing another artifact because previous modifications remain unverified.",
				unverified.map((event) => event.eventId),
			);
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
