import { describe, expect, it } from "vitest";
import { evaluateAkashaPolicy } from "../src/core/akasha/policy-kernel.js";

describe("Akasha policy kernel", () => {
	it("allows actions when no policy rule matches", () => {
		const decision = evaluateAkashaPolicy({
			actionType: "tool_call",
			rules: [{ id: "destructive_command", description: "Block destructive commands", severity: "critical" }],
			payload: {},
		});

		expect(decision).toMatchObject({ action: "allow", severity: "info" });
	});

	it("blocks destructive command policy matches", () => {
		const decision = evaluateAkashaPolicy({
			actionType: "tool_call",
			payload: { dangerousCommandLabel: "git reset hard" },
			rules: [{ id: "destructive_command", description: "Block destructive commands", severity: "critical" }],
		});

		expect(decision).toMatchObject({
			action: "block",
			ruleId: "destructive_command",
			severity: "critical",
		});
	});

	it("requires validation when evidence shows unverified artifacts", () => {
		const decision = evaluateAkashaPolicy({
			actionType: "tool_call",
			evidenceEvents: [
				{
					eventId: "evt-1",
					kind: "artifact.patched",
					sessionId: "session-1",
					streamId: "session:session-1",
					sequence: 1,
					eventTime: "2026-05-12T00:00:00.000Z",
					recordedTime: "2026-05-12T00:00:00.000Z",
					actor: "tool",
					parentEventIds: [],
					payload: { path: "src/app.ts" },
					importance: 0.9,
					ttlPolicy: "long_term",
					version: 1,
				},
			],
			rules: [
				{
					id: "unverified_artifact_widening",
					description: "Require validation before widening edits",
					severity: "warning",
				},
			],
		});

		expect(decision).toMatchObject({
			action: "require_validation",
			ruleId: "unverified_artifact_widening",
			evidenceEventIds: ["evt-1"],
			validationPlan: {
				evidenceEventIds: ["evt-1"],
			},
		});
		expect(decision.validationPlan?.recommendedCommands).toContain("npm test");
	});

	it("can defer actions with a concrete callback schedule", () => {
		const decision = evaluateAkashaPolicy({
			actionType: "tool_call",
			subject: "write",
			now: new Date("2026-05-12T00:00:00.000Z"),
			payload: {
				dueTime: "2026-05-13T00:00:00.000Z",
				summary: "Resume after user confirmation",
				targetEventId: "evt-target",
			},
			rules: [{ id: "defer_until_callback", description: "Defer until callback", severity: "warning" }],
		});

		expect(decision).toMatchObject({
			action: "defer",
			ruleId: "defer_until_callback",
			callback: {
				dueTime: "2026-05-13T00:00:00.000Z",
				summary: "Resume after user confirmation",
				targetEventId: "evt-target",
			},
		});
	});

	it("blocks stale ephemeral state when it is also marked current", () => {
		const decision = evaluateAkashaPolicy({
			actionType: "context_injection",
			payload: {
				currentStateIds: ["state-1"],
				staleEphemeralStateIds: ["state-1"],
			},
			rules: [
				{
					id: "block_stale_ephemeral_state_as_current",
					description: "Block stale current facts",
					severity: "critical",
				},
			],
		});

		expect(decision).toMatchObject({
			action: "block",
			ruleId: "block_stale_ephemeral_state_as_current",
			evidenceEventIds: ["state-1"],
		});
	});

	it("requires currentness checks for stale health states when no check is injected", () => {
		const decision = evaluateAkashaPolicy({
			actionType: "context_injection",
			payload: {
				staleHealthStateIds: ["state-health"],
				currentnessCheckCount: 0,
			},
			rules: [
				{
					id: "require_currentness_check_for_health_state",
					description: "Require health currentness checks",
					severity: "warning",
				},
			],
		});

		expect(decision).toMatchObject({
			action: "require_validation",
			ruleId: "require_currentness_check_for_health_state",
			evidenceEventIds: ["state-health"],
		});
	});
});
