import { describe, expect, it } from "vitest";
import { akashaRecallScopeMatches, createAkashaMemoryRecallScope } from "../src/core/akasha/memory-recall-scope.js";

describe("Akasha memory recall scope", () => {
	it("allows credit assignment within the same turn", () => {
		const scope = createAkashaMemoryRecallScope({
			turnId: "turn-1",
			correlationId: "turn-1",
			expiresAfterTurn: true,
		});

		expect(
			akashaRecallScopeMatches({
				scope,
				currentTurnEventId: "turn-1",
				correlationId: "turn-1",
			}),
		).toBe(true);
	});

	it("blocks credit assignment after the recall turn expires", () => {
		const scope = createAkashaMemoryRecallScope({
			turnId: "turn-1",
			correlationId: "turn-1",
			expiresAfterTurn: true,
		});

		expect(
			akashaRecallScopeMatches({
				scope,
				currentTurnEventId: "turn-2",
				correlationId: "turn-2",
			}),
		).toBe(false);
	});
});
