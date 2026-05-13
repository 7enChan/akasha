import { describe, expect, it } from "vitest";
import { buildAkashaProceduralMemories } from "../src/core/akasha/procedural-memory.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha procedural memory", () => {
	it("derives reusable procedures from successful validation commands", () => {
		const procedures = buildAkashaProceduralMemories([
			event(1, "command.executed", {
				command: "npm --prefix packages/coding-agent test -- akasha",
				exitCode: 0,
				cwd: "/repo",
			}),
		]);

		expect(procedures).toHaveLength(1);
		expect(procedures[0]).toMatchObject({
			maturity: "candidate",
			title: "Validate with npm --prefix packages/coding-agent test -- akasha",
			validation: ["npm --prefix packages/coding-agent test -- akasha"],
			successCount: 1,
			failureCount: 0,
		});
	});

	it("matures validation procedures after repeated success in the same scope", () => {
		const procedures = buildAkashaProceduralMemories([
			event(1, "command.executed", {
				command: "npm --prefix packages/coding-agent test -- akasha",
				exitCode: 0,
				cwd: "/repo",
			}),
			event(2, "command.executed", {
				command: "npm --prefix packages/coding-agent test -- akasha",
				exitCode: 0,
				cwd: "/repo",
			}),
		]);

		expect(procedures[0]).toMatchObject({
			maturity: "validated",
			successCount: 2,
		});
	});

	it("updates procedure counts from procedure feedback events", () => {
		const created = event(1, "skill.procedure.created", {
			procedureId: "procedure-1",
			scopeKey: "validation:/repo:npm test",
			maturity: "validated",
			title: "Validate with npm test",
			trigger: "/repo",
			steps: ["Run npm test"],
			contraindications: [],
			validation: ["npm test"],
			sourceEventIds: ["evt-source"],
			confidence: 0.8,
			successCount: 2,
			failureCount: 0,
		});
		const reinforced = event(2, "skill.procedure.reinforced", {
			procedureId: "procedure-1",
			title: "Validate with npm test",
			steps: ["Run npm test"],
			sourceEventIds: ["evt-source"],
			appliedEventId: "applied-1",
			outcomeEventId: "outcome-1",
		});
		const failed = event(3, "skill.procedure.failed", {
			procedureId: "procedure-1",
			title: "Validate with npm test",
			steps: ["Run npm test"],
			sourceEventIds: ["evt-source"],
			appliedEventId: "applied-2",
			outcomeEventId: "outcome-2",
		});

		const procedures = buildAkashaProceduralMemories([created, reinforced, failed]);

		expect(procedures[0]).toMatchObject({
			procedureId: "procedure-1",
			successCount: 3,
			failureCount: 1,
			maturity: "validated",
		});
	});

	it("derives cautionary procedures from failure lessons", () => {
		const procedures = buildAkashaProceduralMemories([
			event(1, "failure.lesson_learned", {
				lesson: "Check package root before running tests",
				failureKey: "bash",
				confidence: 0.8,
			}),
		]);

		expect(procedures[0]?.steps.join(" ")).toContain("Check package root");
		expect(procedures[0]?.contraindications[0]).toContain("bash");
	});
});

function event(sequence: number, kind: AkashaEvent["kind"], payload: Record<string, unknown>): AkashaEvent {
	return {
		eventId: `evt-${sequence}`,
		kind,
		sessionId: "session-1",
		streamId: "session:session-1",
		sequence,
		eventTime: new Date(sequence * 1000).toISOString(),
		recordedTime: new Date(sequence * 1000).toISOString(),
		actor: "system",
		parentEventIds: [],
		payload,
		importance: 0.5,
		ttlPolicy: "long_term",
		version: 1,
	};
}
