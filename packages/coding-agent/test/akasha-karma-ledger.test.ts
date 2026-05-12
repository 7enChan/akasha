import { describe, expect, it } from "vitest";
import { buildKarmaLedger } from "../src/core/akasha/karma-ledger.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";

describe("buildKarmaLedger", () => {
	it("tracks open, overdue, and resolved promises", () => {
		const ledger = buildKarmaLedger(
			[
				event(1, "promise.created", {
					promiseId: "promise-1",
					summary: "Run validation before closing",
					dueTime: "2026-05-10T00:00:00.000Z",
				}),
				event(2, "promise.created", {
					promiseId: "promise-2",
					summary: "Report final test results",
					dueTime: "2026-05-12T00:00:00.000Z",
				}),
				event(3, "promise.resolved", {
					promiseId: "promise-2",
					resolution: "Reported in final summary",
				}),
			],
			new Date("2026-05-11T00:00:00.000Z"),
		);

		expect(ledger.overduePromiseCount).toBe(1);
		expect(ledger.promises.map((promise) => [promise.promiseId, promise.state])).toEqual([
			["promise-2", "resolved"],
			["promise-1", "overdue"],
		]);
	});

	it("tracks due and corrected predictions", () => {
		const ledger = buildKarmaLedger(
			[
				event(1, "prediction.made", {
					predictionId: "prediction-1",
					claim: "The focused tests will pass",
					checkAfter: "2026-05-10T00:00:00.000Z",
					confidence: 0.7,
				}),
				event(2, "prediction.made", {
					predictionId: "prediction-2",
					claim: "Build may fail on exports",
				}),
				event(3, "prediction.corrected", {
					predictionId: "prediction-2",
					actual: "Build failed on an export mismatch",
					correction: "Export type and value symbols separately",
				}),
			],
			new Date("2026-05-11T00:00:00.000Z"),
		);

		expect(ledger.duePredictionCount).toBe(1);
		expect(ledger.correctedPredictionCount).toBe(1);
		expect(ledger.predictions.map((prediction) => [prediction.predictionId, prediction.state])).toEqual([
			["prediction-2", "corrected"],
			["prediction-1", "due"],
		]);
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
