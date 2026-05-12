import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatAkashaRecallEvalResult, runAkashaRecallEval } from "../src/core/akasha/recall-eval.js";
import { parseAkashaJsonl } from "../src/core/akasha/schema.js";

describe("Akasha recall eval harness", () => {
	it("evaluates must-include and must-exclude recall expectations from fixtures", () => {
		const fixture = readFileSync(join(__dirname, "fixtures", "akasha", "temporal-recall.jsonl"), "utf-8");
		const parsed = parseAkashaJsonl(fixture);

		const result = runAkashaRecallEval(parsed.events, [
			{
				name: "payment build failure recall",
				queryText: "payment build",
				limit: 4,
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
});
