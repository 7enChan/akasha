import { describe, expect, it } from "vitest";
import { buildOpenLoopLedger, deriveOpenLoopEvents } from "../src/core/akasha/open-loops.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("Akasha open loops", () => {
	it("opens a loop for patched artifacts without validation", () => {
		const drafts = deriveOpenLoopEvents(
			[event(1, "artifact.patched", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" })],
			"session-1",
			"session:session-1",
		);

		expect(drafts.map((draft) => draft.kind)).toEqual(["loop.opened"]);
		expect(drafts[0]?.payload?.reason).toBe("artifact_changed_without_validation");
		expect(drafts[0]?.parentEventIds).toEqual(["evt-1"]);
	});

	it("resolves an artifact loop after a later validation command", () => {
		const opened = event(
			2,
			"loop.opened",
			{
				loopKey: "evt-1:artifact_changed_without_validation",
				reason: "artifact_changed_without_validation",
				rootEventId: "evt-1",
				summary: "src/app.ts changed without validation",
				state: "open",
			},
			{ parentEventIds: ["evt-1"], objectId: "src/app.ts" },
		);
		const drafts = deriveOpenLoopEvents(
			[
				event(1, "artifact.patched", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" }),
				opened,
				event(3, "command.executed", { command: "npm test -- app", isError: false }),
			],
			"session-1",
			"session:session-1",
		);

		expect(drafts.map((draft) => draft.kind)).toEqual(["loop.resolved"]);
		expect(drafts[0]?.payload?.resolverEventId).toBe("evt-3");
	});

	it("does not resolve an artifact loop after broad validation without artifact scope", () => {
		const opened = event(
			2,
			"loop.opened",
			{
				loopKey: "evt-1:artifact_changed_without_validation",
				reason: "artifact_changed_without_validation",
				rootEventId: "evt-1",
				summary: "src/app.ts changed without validation",
				state: "open",
			},
			{ parentEventIds: ["evt-1"], objectId: "src/app.ts" },
		);
		const drafts = deriveOpenLoopEvents(
			[
				event(1, "artifact.patched", { path: "src/app.ts", isError: false }, { objectId: "src/app.ts" }),
				opened,
				event(3, "command.executed", { command: "npm test", isError: false }),
			],
			"session-1",
			"session:session-1",
		);

		expect(drafts.map((draft) => draft.kind)).toEqual([]);
	});

	it("resolves a failed tool loop after a later same-tool success", () => {
		const drafts = deriveOpenLoopEvents(
			[
				event(
					1,
					"tool.completed",
					{ toolName: "bash", isError: true, text: "failed" },
					{
						objectId: "bash",
						toolCallId: "call-1",
					},
				),
				event(
					2,
					"loop.opened",
					{
						loopKey: "evt-1:tool_failed_without_recovery",
						reason: "tool_failed_without_recovery",
						rootEventId: "evt-1",
						summary: "bash failed without recovery",
						state: "open",
					},
					{ parentEventIds: ["evt-1"], objectId: "bash", toolCallId: "call-1" },
				),
				event(
					3,
					"tool.completed",
					{ toolName: "bash", isError: false },
					{ objectId: "bash", toolCallId: "call-2" },
				),
			],
			"session-1",
			"session:session-1",
		);

		expect(drafts.map((draft) => draft.kind)).toEqual(["loop.resolved"]);
	});

	it("builds a ledger from opened and resolved loop events", () => {
		const ledger = buildOpenLoopLedger([
			event(1, "loop.opened", {
				loopKey: "root:tool_failed_without_recovery",
				reason: "tool_failed_without_recovery",
				rootEventId: "root",
				summary: "bash failed",
				state: "open",
			}),
			event(2, "loop.resolved", {
				loopKey: "root:tool_failed_without_recovery",
				reason: "tool_failed_without_recovery",
				rootEventId: "root",
				summary: "resolved",
				state: "resolved",
			}),
		]);

		expect(ledger).toMatchObject([
			{
				loopKey: "root:tool_failed_without_recovery",
				state: "resolved",
				rootEventId: "root",
			},
		]);
	});

	it("resolves prediction_due loops after prediction calibration", () => {
		const drafts = deriveOpenLoopEvents(
			[
				event(1, "prediction.made", {
					predictionId: "prediction-1",
					claim: "Build should pass",
				}),
				event(2, "loop.opened", {
					loopKey: "prediction-1:prediction_due",
					reason: "prediction_due",
					rootEventId: "evt-1",
					summary: "Prediction due for calibration",
					state: "open",
				}),
				event(3, "prediction.corrected", {
					predictionId: "prediction-1",
					actual: "failed: npm run build",
					correct: false,
				}),
			],
			"session-1",
			"session:session-1",
		);

		expect(drafts.map((draft) => draft.kind)).toEqual(["loop.resolved"]);
		expect(drafts[0]?.payload?.resolverEventId).toBe("evt-3");
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
