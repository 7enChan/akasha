import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	formatAkashaDogfoodMemoryEvalResult,
	runAkashaDogfoodMemoryEval,
} from "../src/core/akasha/dogfood-memory-eval.js";
import type { AkashaSemanticMemorySeed } from "../src/core/akasha/semantic-memory-seed.js";

describe("Akasha dogfood memory eval", () => {
	it("loads Akasha event logs and enforces longitudinal quality budgets", () => {
		const result = runAkashaDogfoodMemoryEval(
			[
				{
					name: "m54 fixture as dogfood corpus",
					eventLogPaths: [longitudinalFixturePath()],
					cases: [
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
					],
					semanticSeeds,
					budget: {
						minRecallHitRate: 1,
						maxPollutionRate: 0,
						minOpenLoopCoverage: 1,
						minCurrentnessCoverage: 1,
						minActionGateCoverage: 1,
						maxEstimatedActionGateTokens: 2_000,
						maxDurationMs: 10_000,
						maxParseIssues: 0,
					},
				},
			],
			{
				cwd: "/repo",
				now: "2026-05-14T12:00:00.000Z",
			},
		);

		expect(result.passed).toBe(true);
		expect(result.metrics).toMatchObject({
			corpusCount: 1,
			sourceCount: 1,
			parseIssueCount: 0,
			failedCorpusCount: 0,
		});
		expect(result.metrics.eventCount).toBeGreaterThan(0);
		expect(result.metrics.maxEstimatedActionGateTokens).toBeGreaterThan(0);
		expect(formatAkashaDogfoodMemoryEvalResult(result)).toContain("Akasha dogfood memory eval passed.");
	});

	it("reports budget and parse failures with corpus names", () => {
		const result = runAkashaDogfoodMemoryEval(
			[
				{
					name: "broken dogfood corpus",
					eventLogContents: ["{not-json}\n"],
					cases: [
						{
							name: "missing recall",
							queryText: "nothing",
							mustRecall: ["evt-missing"],
						},
					],
					budget: {
						minRecallHitRate: 1,
						maxEstimatedActionGateTokens: 0,
						maxDurationMs: 0,
						maxParseIssues: 0,
					},
				},
			],
			{ now: "2026-05-14T12:00:00.000Z" },
		);

		expect(result.passed).toBe(false);
		expect(result.corpora[0]?.parseIssues).toHaveLength(1);
		expect(result.corpora[0]?.budgetFailures.some((failure) => failure.includes("recall hit rate"))).toBe(true);
		expect(formatAkashaDogfoodMemoryEvalResult(result)).toContain("- broken dogfood corpus:");
	});
});

function longitudinalFixturePath(): string {
	return join(__dirname, "fixtures", "akasha", "longitudinal-memory.jsonl");
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
	};
	return (byQuery[queryText ?? ""] ?? []).map((eventId, index) => ({
		eventId,
		score: 0.9 - index * 0.05,
		similarity: 0.92 - index * 0.03,
		reason: `fixture:${queryText}:${eventId}`,
	}));
}
