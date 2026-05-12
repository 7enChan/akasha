import { buildAkashaActionGateContext } from "./action-gate.js";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { buildKarmaLedger } from "./karma-ledger.js";
import { type AkashaTaskGraphEdgeType, buildAkashaTaskModel } from "./task-model.js";
import { buildTemporalState } from "./temporal-state.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaTaskGraphEdgeExpectation {
	type: AkashaTaskGraphEdgeType;
	from?: string;
	to?: string;
}

export interface AkashaTemporalBehaviorEvalCase {
	name: string;
	expectOpenPromises?: string[];
	expectUnverifiedArtifacts?: string[];
	expectSuppressedAbsent?: string[];
	expectActionGateIncludes?: string[];
	expectActionGateExcludes?: string[];
	expectTaskGraphEdges?: AkashaTaskGraphEdgeExpectation[];
}

export interface AkashaTemporalBehaviorEvalFailure {
	caseName: string;
	message: string;
}

export interface AkashaTemporalBehaviorEvalResult {
	passed: boolean;
	failures: AkashaTemporalBehaviorEvalFailure[];
}

export function runAkashaTemporalBehaviorEval(
	events: AkashaEvent[],
	cases: AkashaTemporalBehaviorEvalCase[],
): AkashaTemporalBehaviorEvalResult {
	const governed = projectAkashaGovernedEvents(events).events;
	const governedIds = new Set(governed.map((event) => event.eventId));
	const karma = buildKarmaLedger(governed);
	const temporalState = buildTemporalState(governed);
	const taskModel = buildAkashaTaskModel(governed);
	const actionGate = buildAkashaActionGateContext({ sessionEvents: governed })?.text ?? "";
	const failures: AkashaTemporalBehaviorEvalFailure[] = [];

	for (const testCase of cases) {
		for (const promiseId of testCase.expectOpenPromises ?? []) {
			const promise = karma.promises.find((item) => item.promiseId === promiseId && item.state !== "resolved");
			if (!promise) failures.push(failure(testCase, `missing open promise ${promiseId}`));
		}

		for (const path of testCase.expectUnverifiedArtifacts ?? []) {
			const artifact = temporalState.activeFiles.find((file) => file.path === path && file.hasUnverifiedChange);
			if (!artifact) failures.push(failure(testCase, `missing unverified artifact ${path}`));
		}

		for (const eventId of testCase.expectSuppressedAbsent ?? []) {
			if (governedIds.has(eventId)) failures.push(failure(testCase, `suppressed event still visible ${eventId}`));
		}

		for (const text of testCase.expectActionGateIncludes ?? []) {
			if (!actionGate.includes(text)) failures.push(failure(testCase, `action gate missing ${text}`));
		}

		for (const text of testCase.expectActionGateExcludes ?? []) {
			if (actionGate.includes(text)) failures.push(failure(testCase, `action gate unexpectedly contains ${text}`));
		}

		for (const expected of testCase.expectTaskGraphEdges ?? []) {
			const matched = taskModel.graph.edges.some(
				(edge) =>
					edge.type === expected.type &&
					(!expected.from || edge.from === expected.from) &&
					(!expected.to || edge.to === expected.to),
			);
			if (!matched) {
				failures.push(
					failure(
						testCase,
						`missing graph edge ${expected.type} ${expected.from ?? "*"} -> ${expected.to ?? "*"}`,
					),
				);
			}
		}
	}

	return {
		passed: failures.length === 0,
		failures,
	};
}

export function formatAkashaTemporalBehaviorEvalResult(result: AkashaTemporalBehaviorEvalResult): string {
	if (result.passed) return "Akasha temporal behavior eval passed.";
	return [
		"Akasha temporal behavior eval failed:",
		...result.failures.map((item) => `- ${item.caseName}: ${item.message}`),
	].join("\n");
}

function failure(testCase: AkashaTemporalBehaviorEvalCase, message: string): AkashaTemporalBehaviorEvalFailure {
	return {
		caseName: testCase.name,
		message,
	};
}
