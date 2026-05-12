import { rankRecallEvents } from "./recall-policy.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaRecallEvalCase {
	name: string;
	queryText?: string;
	limit?: number;
	mustInclude?: string[];
	mustExclude?: string[];
}

export interface AkashaRecallEvalFailure {
	caseName: string;
	missing: string[];
	unexpected: string[];
	selected: string[];
}

export interface AkashaRecallEvalResult {
	passed: boolean;
	failures: AkashaRecallEvalFailure[];
}

export interface AkashaRecallEvalOptions {
	rank?: (events: AkashaEvent[], queryText?: string) => AkashaEvent[];
	defaultLimit?: number;
}

export function runAkashaRecallEval(
	events: AkashaEvent[],
	cases: AkashaRecallEvalCase[],
	options: AkashaRecallEvalOptions = {},
): AkashaRecallEvalResult {
	const rank = options.rank ?? rankRecallEvents;
	const defaultLimit = Math.max(1, Math.floor(options.defaultLimit ?? 8));
	const failures: AkashaRecallEvalFailure[] = [];

	for (const testCase of cases) {
		const limit = Math.max(1, Math.floor(testCase.limit ?? defaultLimit));
		const selected = rank(events, testCase.queryText)
			.slice(0, limit)
			.map((event) => event.eventId);
		const selectedIds = new Set(selected);
		const missing = (testCase.mustInclude ?? []).filter((eventId) => !selectedIds.has(eventId));
		const unexpected = (testCase.mustExclude ?? []).filter((eventId) => selectedIds.has(eventId));
		if (missing.length > 0 || unexpected.length > 0) {
			failures.push({
				caseName: testCase.name,
				missing,
				unexpected,
				selected,
			});
		}
	}

	return {
		passed: failures.length === 0,
		failures,
	};
}

export function formatAkashaRecallEvalResult(result: AkashaRecallEvalResult): string {
	if (result.passed) return "Akasha recall eval passed.";
	return [
		"Akasha recall eval failed:",
		...result.failures.map(
			(failure) =>
				`- ${failure.caseName}: missing [${failure.missing.join(", ") || "none"}], unexpected [${
					failure.unexpected.join(", ") || "none"
				}], selected [${failure.selected.join(", ") || "none"}]`,
		),
	].join("\n");
}
