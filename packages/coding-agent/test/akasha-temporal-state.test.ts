import { describe, expect, it } from "vitest";
import { buildTemporalState } from "../src/core/akasha/temporal-state.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("buildTemporalState", () => {
	it("summarizes current intent, active files, failed tools, and open loop candidates", () => {
		const events = [
			event(1, "message.user.submitted", { text: "Patch src/app.ts and run tests" }, { actor: "user" }),
			event(2, "artifact.patched", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" }),
			event(
				3,
				"tool.completed",
				{ toolName: "bash", isError: true, text: "test failed" },
				{
					toolCallId: "call-1",
					objectId: "bash",
				},
			),
		];

		const state = buildTemporalState(events);

		expect(state.currentIntent?.text).toContain("Patch src/app.ts");
		expect(state.activeFiles.map((file) => file.path)).toEqual(["src/app.ts"]);
		expect(state.activeFiles[0]?.hasUnverifiedChange).toBe(true);
		expect(state.failedTools.map((tool) => tool.toolCallId)).toEqual(["call-1"]);
		expect(state.openLoopCandidates.map((loop) => loop.reason)).toEqual(
			expect.arrayContaining(["artifact_changed_without_validation", "tool_failed_without_recovery"]),
		);
	});

	it("marks modified files verified after a later successful validation command", () => {
		const events = [
			event(1, "artifact.patched", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" }),
			event(2, "command.executed", { command: "npm test -- app", isError: false }, { objectId: "npm test" }),
		];

		const state = buildTemporalState(events);

		expect(state.activeFiles[0]?.hasUnverifiedChange).toBe(false);
		expect(state.openLoopCandidates.map((loop) => loop.reason)).not.toContain("artifact_changed_without_validation");
	});

	it("keeps unverified state after reads and broad validation commands", () => {
		const events = [
			event(1, "artifact.patched", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" }),
			event(2, "artifact.read", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" }),
			event(3, "command.executed", { command: "npm test", isError: false }, { objectId: "npm test" }),
		];

		const state = buildTemporalState(events);

		expect(state.activeFiles[0]?.hasUnverifiedChange).toBe(true);
		expect(state.openLoopCandidates.map((loop) => loop.reason)).toContain("artifact_changed_without_validation");
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
