import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	formatAkashaLongitudinalMemoryEvalResult,
	runAkashaLongitudinalMemoryEval,
} from "../src/core/akasha/longitudinal-memory-eval.js";
import { parseAkashaJsonl } from "../src/core/akasha/schema.js";
import type { AkashaSemanticMemorySeed } from "../src/core/akasha/semantic-memory-seed.js";

describe("Akasha longitudinal memory eval", () => {
	it("measures cross-day recall quality, pollution, currentness, and open-loop coverage", () => {
		const parsed = parseAkashaJsonl(longitudinalFixture());
		const result = runAkashaLongitudinalMemoryEval(
			parsed.events,
			[
				{
					name: "cross-day coding memory",
					queryText: "akasha longitudinal memory eval",
					limit: 8,
					mustRecall: [
						"evt-long-failure-lesson",
						"evt-narrow-pref",
						"evt-current-artifact",
						"evt-current-open-loop",
					],
					mustNotRecall: ["evt-old-pnpm-pref"],
					expectOpenLoops: ["evt-current-artifact:artifact_changed_without_validation"],
					expectActionGateIncludes: [
						"Validate longitudinal eval fixture and focused tests",
						"packages/coding-agent/src/core/akasha/longitudinal-memory-eval.ts",
					],
				},
				{
					name: "stale health memory is historical",
					queryText: "stomach health",
					limit: 5,
					mustRecall: ["evt-old-health"],
					expectCurrentnessChecks: ["state-health-stomach"],
					expectActionGateIncludes: ['Before relying on "User said their stomach hurt"'],
					expectActionGateExcludes: ["current health_state state-health-stomach"],
				},
				{
					name: "corrected package manager preference",
					queryText: "package manager commands",
					limit: 6,
					mustRecall: ["evt-npm-pref", "evt-pkg-pref-reconsolidated"],
					mustNotRecall: ["evt-old-pnpm-pref"],
				},
			],
			{
				cwd: "/repo",
				defaultLimit: 8,
				now: "2026-05-14T12:00:00.000Z",
				semanticSeeds,
			},
		);

		expect(parsed.issues).toEqual([]);
		expect(result.passed).toBe(true);
		expect(result.metrics).toMatchObject({
			requiredRecall: 7,
			recalled: 7,
			pollutedRecall: 0,
			expectedOpenLoops: 1,
			coveredOpenLoops: 1,
			expectedCurrentnessChecks: 1,
			coveredCurrentnessChecks: 1,
			staleCurrentFactViolations: 0,
		});
		expect(formatAkashaLongitudinalMemoryEvalResult(result)).toContain("Akasha longitudinal memory eval passed.");
		expect(formatAkashaLongitudinalMemoryEvalResult(result)).toContain("Recall hit rate: 100% (7/7)");
	});

	it("reports actionable diagnostics when longitudinal expectations regress", () => {
		const parsed = parseAkashaJsonl(longitudinalFixture());
		const result = runAkashaLongitudinalMemoryEval(
			parsed.events,
			[
				{
					name: "intentional regression",
					queryText: "akasha longitudinal memory eval",
					limit: 4,
					mustRecall: ["evt-missing"],
					mustNotRecall: ["evt-current-artifact"],
					expectOpenLoops: ["missing-loop"],
					expectCurrentnessChecks: ["missing-state"],
					expectActionGateIncludes: ["missing action gate text"],
					expectActionGateExcludes: ["Validate longitudinal eval fixture and focused tests"],
				},
			],
			{
				cwd: "/repo",
				now: "2026-05-14T12:00:00.000Z",
				semanticSeeds,
			},
		);

		expect(result.passed).toBe(false);
		expect(result.cases[0]).toMatchObject({
			caseName: "intentional regression",
			missingRecall: ["evt-missing"],
			pollutedRecall: ["evt-current-artifact"],
			missingOpenLoops: ["missing-loop"],
			missingCurrentnessChecks: ["missing-state"],
			actionGateMissing: ["missing action gate text"],
			actionGateUnexpected: ["Validate longitudinal eval fixture and focused tests"],
		});
		expect(formatAkashaLongitudinalMemoryEvalResult(result)).toContain(
			"- intentional regression: missing recall [evt-missing]",
		);
	});
});

function longitudinalFixture(): string {
	return readFileSync(join(__dirname, "fixtures", "akasha", "longitudinal-memory.jsonl"), "utf-8");
}

function semanticSeeds(queryText: string | undefined): AkashaSemanticMemorySeed[] {
	const byQuery: Record<string, string[]> = {
		"akasha longitudinal memory eval": [
			"evt-long-failure-lesson",
			"evt-narrow-pref",
			"evt-current-artifact",
			"evt-current-open-loop",
		],
		"stomach health": ["evt-old-health"],
		"package manager commands": ["evt-npm-pref", "evt-pkg-pref-reconsolidated"],
	};
	return (byQuery[queryText ?? ""] ?? []).map((eventId, index) => ({
		eventId,
		score: 0.9 - index * 0.05,
		similarity: 0.92 - index * 0.03,
		reason: `fixture:${queryText}:${eventId}`,
	}));
}
