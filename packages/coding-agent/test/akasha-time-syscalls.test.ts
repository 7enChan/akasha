import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import { buildKarmaLedger } from "../src/core/akasha/karma-ledger.js";
import {
	appendAkashaCommitment,
	appendAkashaCommitmentResolution,
	appendAkashaPrediction,
	appendAkashaPredictionCheck,
} from "../src/core/akasha/time-syscalls.js";

describe("Akasha time syscalls", () => {
	let tempDir: string;
	let store: JsonlAkashaStore;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-syscalls-"));
		store = new JsonlAkashaStore(join(tempDir, "events.jsonl"));
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("creates and resolves explicit commitments", () => {
		const created = appendAkashaCommitment(baseContext("call-1"), {
			summary: "Run full Akasha validation",
			dueTime: "2026-05-12T00:00:00.000Z",
			resolutionCriteria: "All Akasha tests pass",
			confidence: 0.95,
			sourceEventIds: ["evt-assistant"],
		});
		const resolved = appendAkashaCommitmentResolution(baseContext("call-2"), {
			promiseId: created.payload.promiseId as string,
			resolution: "validated",
			evidenceEventId: "evt-build",
		});

		const ledger = buildKarmaLedger(store.buildTimeline());

		expect(created.kind).toBe("promise.created");
		expect(created.payload.source).toBe("syscall");
		expect(created.parentEventIds).toContain("evt-assistant");
		expect(resolved.kind).toBe("promise.resolved");
		expect(ledger.promises[0]).toMatchObject({
			state: "resolved",
			resolution: "validated",
		});
	});

	it("creates and corrects explicit predictions", () => {
		const prediction = appendAkashaPrediction(baseContext("call-3"), {
			claim: "The task graph eval should pass",
			checkAfter: "2026-05-12T00:00:00.000Z",
			confidence: 0.7,
			resolutionCriteria: "Focused test exits 0",
		});
		const checked = appendAkashaPredictionCheck(baseContext("call-4"), {
			predictionId: prediction.payload.predictionId as string,
			actual: "Focused test initially failed",
			correct: false,
			correction: "A fixture assertion needed a stable event",
		});

		const ledger = buildKarmaLedger(store.buildTimeline());

		expect(prediction.kind).toBe("prediction.made");
		expect(checked.kind).toBe("prediction.corrected");
		expect(ledger.predictions[0]).toMatchObject({
			state: "corrected",
			actual: "Focused test initially failed",
			correction: "A fixture assertion needed a stable event",
		});
	});

	function baseContext(toolCallId: string) {
		return {
			store,
			sessionId: "session-1",
			streamId: "session:session-1",
			now: () => "2026-05-11T00:00:00.000Z",
			parentEventIds: ["evt-parent"],
			correlationId: "turn-1",
			toolCallId,
			sourceKeyPrefix: "test-syscall",
		};
	}
});
