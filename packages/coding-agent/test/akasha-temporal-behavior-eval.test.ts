import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAkashaJsonl } from "../src/core/akasha/schema.js";
import {
	formatAkashaTemporalBehaviorEvalResult,
	runAkashaTemporalBehaviorEval,
} from "../src/core/akasha/temporal-behavior-eval.js";

describe("Akasha temporal behavior eval", () => {
	it("evaluates commitments, governed facts, task graph edges, and scoped artifact validation", () => {
		const fixture = readFileSync(join(__dirname, "fixtures", "akasha", "temporal-behavior.jsonl"), "utf-8");
		const parsed = parseAkashaJsonl(fixture);

		const result = runAkashaTemporalBehaviorEval(parsed.events, [
			{
				name: "m18-m20 behavior fixture",
				expectOpenPromises: ["promise:m18"],
				expectUnverifiedArtifacts: ["src/m18.ts"],
				expectSuppressedAbsent: ["evt-private", "evt-private-pref"],
				expectActionGateIncludes: ["Run Akasha M18 tests", "Due callbacks"],
				expectActionGateExcludes: ["temporary secret preference"],
				expectTaskGraphEdges: [
					{ type: "tracks", from: "callback:callback:m18", to: "task:promise:m18" },
					{ type: "blocks", to: "artifact:src/m18.ts" },
				],
			},
		]);

		expect(parsed.issues).toEqual([]);
		expect(formatAkashaTemporalBehaviorEvalResult(result)).toBe("Akasha temporal behavior eval passed.");
		expect(result.passed).toBe(true);
	});
});
