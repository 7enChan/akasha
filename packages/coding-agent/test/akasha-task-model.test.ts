import { describe, expect, it } from "vitest";
import { buildAkashaTaskModel } from "../src/core/akasha/task-model.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha task model", () => {
	it("projects typed goals, tasks, decisions, and risks from events", () => {
		const model = buildAkashaTaskModel([
			event(1, "message.user.submitted", { text: "目标：实现 Akasha Policy Kernel" }, { actor: "user" }),
			event(2, "promise.created", {
				promiseId: "promise-1",
				summary: "Run Akasha tests",
				dueTime: "2026-05-11T00:00:00.000Z",
			}),
			event(3, "artifact.patched", { path: "src/policy.ts", isError: false }, { objectId: "src/policy.ts" }),
			event(4, "message.agent.completed", { text: "I will implement the policy kernel first." }, { actor: "agent" }),
			event(5, "tool.blocked", {
				reason: "Akasha blocked a high-risk command before execution: git reset hard",
				rule: "destructive_command",
			}),
			event(6, "time.callback.scheduled", {
				callbackId: "callback-1",
				summary: "Check Akasha tests",
				dueTime: "2026-05-12T00:00:00.000Z",
				targetEventId: "evt-2",
			}),
		]);

		expect(model.goals).toMatchObject([{ text: "目标：实现 Akasha Policy Kernel", status: "active" }]);
		expect(model.tasks.map((task) => task.text)).toContain("Run Akasha tests");
		expect(model.decisions.map((decision) => decision.text)).toContain("I will implement the policy kernel first.");
		expect(model.callbacks).toMatchObject([{ callbackId: "callback-1", status: "scheduled" }]);
		expect(model.risks.map((risk) => [risk.reason, risk.severity])).toEqual(
			expect.arrayContaining([
				["destructive_command", "critical"],
				["modified_unverified", "medium"],
			]),
		);
		expect(model.graph.nodes.map((node) => node.type)).toEqual(
			expect.arrayContaining(["goal", "task", "decision", "risk", "artifact", "callback"]),
		);
		expect(model.graph.edges.map((edge) => [edge.type, edge.from, edge.to])).toEqual(
			expect.arrayContaining([
				["belongs_to", "task:promise-1", "goal:evt-1"],
				["tracks", "callback:callback-1", "task:promise-1"],
				["blocks", "risk:artifact:src/policy.ts:modified_unverified", "artifact:src/policy.ts"],
			]),
		);
	});
});

function event(
	sequence: number,
	kind: AkashaEvent["kind"],
	payload: Record<string, unknown>,
	overrides: Partial<AkashaEvent> = {},
): AkashaEvent {
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
		...overrides,
	};
}
