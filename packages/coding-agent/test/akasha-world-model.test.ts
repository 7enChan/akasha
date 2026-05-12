import { describe, expect, it } from "vitest";
import { buildArtifactStates } from "../src/core/akasha/artifact-state.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";
import { buildWorldModel } from "../src/core/akasha/world-model.js";

describe("Akasha world model", () => {
	it("projects artifact status from reads, writes, and validation commands", () => {
		const states = buildArtifactStates([
			event(1, "artifact.read", { path: "src/app.ts" }, { objectId: "src/app.ts" }),
			event(2, "artifact.patched", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" }),
			event(3, "command.executed", { command: "npm test -- app", isError: false }),
		]);

		expect(states).toMatchObject([
			{
				path: "src/app.ts",
				status: "modified_verified",
				readCount: 1,
				patchCount: 1,
				lastValidationEventId: "evt-3",
				lastValidationScope: "file",
			},
		]);
	});

	it("does not mark every modified artifact verified after broad project validation", () => {
		const states = buildArtifactStates([
			event(1, "artifact.patched", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" }),
			event(2, "artifact.patched", { path: "src/settings.ts", isError: false }, { objectId: "src/settings.ts" }),
			event(3, "command.executed", { command: "npm test", isError: false }),
		]);

		expect(states.map((state) => [state.path, state.status, state.lastValidationScope])).toEqual(
			expect.arrayContaining([
				["src/app.ts", "modified_unverified", "project"],
				["src/settings.ts", "modified_unverified", "project"],
			]),
		);
		expect(states.every((state) => state.lastValidationObservedEventId === "evt-3")).toBe(true);
	});

	it("summarizes current goal, active files, blockers, and decisions", () => {
		const model = buildWorldModel([
			event(1, "message.user.submitted", { text: "Patch the CLI settings flow" }, { actor: "user" }),
			event(2, "artifact.patched", { path: "src/settings.ts", isError: false }, { objectId: "src/settings.ts" }),
			event(3, "loop.opened", {
				loopKey: "evt-2:artifact_changed_without_validation",
				rootEventId: "evt-2",
				reason: "artifact_changed_without_validation",
				summary: "src/settings.ts changed without validation",
				state: "open",
			}),
			event(4, "message.agent.completed", { text: "I will validate the settings flow next." }, { actor: "agent" }),
		]);

		expect(model.projectState.currentGoal).toBe("Patch the CLI settings flow");
		expect(model.projectState.activeFiles.map((file) => file.path)).toEqual(["src/settings.ts"]);
		expect(model.projectState.blockers.map((blocker) => blocker.rootEventId)).toEqual(["evt-2"]);
		expect(model.projectState.recentDecisions.map((decision) => decision.eventId)).toEqual(["evt-4"]);
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
