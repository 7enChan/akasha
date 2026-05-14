import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	formatAkashaRecallEvalResult,
	runAkashaFieldRecallEval,
	runAkashaRecallEval,
} from "../src/core/akasha/recall-eval.js";
import { parseAkashaJsonl } from "../src/core/akasha/schema.js";

describe("Akasha recall eval harness", () => {
	it("evaluates must-include and must-exclude recall expectations from fixtures", () => {
		const fixture = readFileSync(join(__dirname, "fixtures", "akasha", "temporal-recall.jsonl"), "utf-8");
		const parsed = parseAkashaJsonl(fixture);

		const result = runAkashaRecallEval(parsed.events, [
			{
				name: "payment build failure recall",
				queryText: "payment build",
				limit: 5,
				mustInclude: ["evt-current-failure", "evt-active-file", "evt-user-current"],
				mustExclude: ["evt-stale-loop"],
			},
		]);

		expect(parsed.issues).toEqual([]);
		expect(formatAkashaRecallEvalResult(result)).toBe("Akasha recall eval passed.");
		expect(result.passed).toBe(true);
	});

	it("reports missing and unexpected events for regression diagnostics", () => {
		const fixture = readFileSync(join(__dirname, "fixtures", "akasha", "temporal-recall.jsonl"), "utf-8");
		const parsed = parseAkashaJsonl(fixture);
		const result = runAkashaRecallEval(parsed.events, [
			{
				name: "intentional failure",
				queryText: "payment build",
				limit: 1,
				mustInclude: ["evt-active-file"],
				mustExclude: ["evt-current-failure"],
			},
		]);

		expect(result.passed).toBe(false);
		expect(result.failures[0]).toMatchObject({
			caseName: "intentional failure",
			missing: ["evt-active-file"],
			unexpected: ["evt-current-failure"],
		});
	});

	it("evaluates trace-field edge recall and supersession behavior", () => {
		const fixture = readFileSync(join(__dirname, "fixtures", "akasha", "temporal-recall.jsonl"), "utf-8");
		const parsed = parseAkashaJsonl(fixture);
		const result = runAkashaFieldRecallEval(
			parsed.events,
			[
				{
					name: "ledger artifact spreads to failure and validation",
					queryText: "ledger file",
					limit: 5,
					mustInclude: ["evt-edge-artifact", "evt-edge-failure", "evt-edge-validation"],
					mustExclude: ["evt-current-failure"],
				},
				{
					name: "semantic seed bridges query to ledger field",
					queryText: "payment build",
					limit: 8,
					mustInclude: ["evt-edge-artifact", "evt-edge-failure", "evt-edge-validation"],
				},
				{
					name: "callback field recalls due and closure chain",
					queryText: "callback-77",
					limit: 6,
					mustInclude: ["evt-callback-due", "evt-callback-completed"],
				},
				{
					name: "port correction supersedes old port",
					queryText: "dev server port",
					limit: 4,
					mustInclude: ["evt-new-port"],
					mustExclude: ["evt-old-port"],
				},
			],
			{
				cwd: "/repo",
				defaultLimit: 8,
				now: "2026-05-12T00:14:00.000Z",
				semanticSeeds: (queryText) =>
					queryText === "payment build"
						? [
								{
									eventId: "evt-edge-artifact",
									score: 0.55,
									similarity: 0.84,
									reason: "embedding:event:event:evt-edge-artifact:v1:0.8400",
								},
							]
						: [],
			},
		);

		expect(parsed.issues).toEqual([]);
		expect(formatAkashaRecallEvalResult(result)).toBe("Akasha recall eval passed.");
		expect(result.passed).toBe(true);
	});
});
