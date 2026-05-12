import { buildKarmaLedger } from "./karma-ledger.js";
import { buildOpenLoopLedger } from "./open-loops.js";
import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent, AkashaEventDraft, AkashaStore } from "./types.js";

export interface AkashaSchedulerOptions {
	now?: Date;
	limit?: number;
}

export interface AkashaSchedulerResult {
	appended: AkashaEvent[];
	overduePromises: number;
	duePredictions: number;
	resolvedPromises: number;
	checkedPredictions: number;
	correctedPredictions: number;
}

export function runAkashaSchedulerPass(
	store: AkashaStore,
	options: AkashaSchedulerOptions = {},
): AkashaSchedulerResult {
	const now = options.now ?? new Date();
	const events = store.buildTimeline({ limit: options.limit ?? Number.MAX_SAFE_INTEGER });
	const drafts = deriveSchedulerEvents(events, now);
	const appended = drafts.map((draft) => store.append(draft));
	return {
		appended,
		overduePromises: appended.filter((event) => event.kind === "promise.updated").length,
		duePredictions: appended.filter((event) => event.kind === "loop.opened").length,
		resolvedPromises: appended.filter((event) => event.kind === "promise.resolved").length,
		checkedPredictions: appended.filter((event) => event.kind === "prediction.checked").length,
		correctedPredictions: appended.filter((event) => event.kind === "prediction.corrected").length,
	};
}

export function deriveSchedulerEvents(events: AkashaEvent[], now: Date = new Date()): AkashaEventDraft[] {
	const ordered = orderAkashaEvents(events);
	const ledger = buildKarmaLedger(ordered, now);
	const openLoops = buildOpenLoopLedger(ordered);
	const openLoopKeys = new Set(openLoops.filter((loop) => loop.state !== "resolved").map((loop) => loop.loopKey));
	const sessionId = ordered.at(-1)?.sessionId ?? "unknown";
	const streamId = ordered.at(-1)?.streamId ?? `session:${sessionId}`;
	const eventTime = now.toISOString();
	const drafts: AkashaEventDraft[] = [];

	for (const promise of ledger.promises) {
		if (promise.state === "open" || promise.state === "overdue") {
			const evidence = findPromiseEvidence(promise.createdEventId, promise.summary, ordered);
			if (evidence) {
				drafts.push({
					kind: "promise.resolved",
					sessionId,
					streamId,
					eventTime: evidence.eventTime,
					actor: "system",
					subjectId: "akasha.scheduler",
					sourceKey: `scheduler:promise-resolved:${promise.promiseId}:${evidence.eventId}`,
					parentEventIds: [promise.lastEventId, evidence.eventId],
					payload: {
						promiseId: promise.promiseId,
						summary: promise.summary,
						resolution: `Resolved by ${formatEvidence(evidence)}`,
						resolverEventId: evidence.eventId,
					},
					importance: 0.75,
					ttlPolicy: "long_term",
				});
				continue;
			}
		}
		if (promise.state !== "overdue") continue;
		drafts.push({
			kind: "promise.updated",
			sessionId,
			streamId,
			eventTime,
			actor: "system",
			subjectId: "akasha.scheduler",
			sourceKey: `scheduler:promise-overdue:${promise.promiseId}:${promise.dueTime ?? promise.createdTime}`,
			parentEventIds: [promise.lastEventId],
			payload: {
				promiseId: promise.promiseId,
				summary: promise.summary,
				dueTime: promise.dueTime,
				state: "overdue",
			},
			importance: 0.8,
			ttlPolicy: "long_term",
		});
	}

	for (const prediction of ledger.predictions) {
		if (prediction.state === "pending" || prediction.state === "due") {
			const evidence = findPredictionEvidence(prediction.createdEventId, prediction.claim, ordered);
			if (evidence) {
				const expected = expectedPredictionOutcome(prediction.claim);
				if (expected) {
					const actualPassed = evidence.payload.isError !== true;
					const correct = expected === "pass" ? actualPassed : !actualPassed;
					drafts.push({
						kind: correct ? "prediction.checked" : "prediction.corrected",
						sessionId,
						streamId,
						eventTime: evidence.eventTime,
						actor: "system",
						subjectId: "akasha.scheduler",
						sourceKey: `scheduler:prediction-${correct ? "checked" : "corrected"}:${prediction.predictionId}:${evidence.eventId}`,
						parentEventIds: [prediction.lastEventId, evidence.eventId],
						payload: {
							predictionId: prediction.predictionId,
							claim: prediction.claim,
							actual: formatEvidence(evidence),
							correct,
							correction: correct
								? undefined
								: `Expected "${prediction.claim}", but observed ${formatEvidence(evidence)}.`,
							evidenceEventId: evidence.eventId,
						},
						importance: correct ? 0.7 : 0.9,
						ttlPolicy: "long_term",
					});
					continue;
				}
			}
		}
		if (prediction.state !== "due") continue;
		const loopKey = `${prediction.predictionId}:prediction_due`;
		if (openLoopKeys.has(loopKey)) continue;
		drafts.push({
			kind: "loop.opened",
			sessionId,
			streamId,
			eventTime,
			actor: "system",
			subjectId: "akasha.scheduler",
			sourceKey: `scheduler:prediction-due:${prediction.predictionId}:${prediction.checkAfter ?? prediction.createdTime}`,
			parentEventIds: [prediction.lastEventId],
			payload: {
				loopKey,
				reason: "prediction_due",
				rootEventId: prediction.createdEventId,
				summary: `Prediction due for calibration: ${prediction.claim}`,
				state: "open",
			},
			importance: 0.85,
			ttlPolicy: "long_term",
		});
	}

	return drafts;
}

function findPromiseEvidence(createdEventId: string, summary: string, events: AkashaEvent[]): AkashaEvent | undefined {
	const normalized = summary.toLowerCase();
	if (!mentionsValidation(normalized)) return undefined;
	return findLaterEvent(createdEventId, events, (event) => {
		if (event.kind !== "command.executed" || event.payload.isError === true) return false;
		const command = typeof event.payload.command === "string" ? event.payload.command.toLowerCase() : "";
		return isValidationCommand(command) && overlapsValidationIntent(normalized, command);
	});
}

function findPredictionEvidence(createdEventId: string, claim: string, events: AkashaEvent[]): AkashaEvent | undefined {
	const expected = expectedPredictionOutcome(claim);
	if (!expected) return undefined;
	const normalized = claim.toLowerCase();
	return findLaterEvent(createdEventId, events, (event) => {
		if (event.kind !== "command.executed") return false;
		const command = typeof event.payload.command === "string" ? event.payload.command.toLowerCase() : "";
		return (
			isValidationCommand(command) &&
			(!mentionsValidation(normalized) || overlapsValidationIntent(normalized, command))
		);
	});
}

function findLaterEvent(
	rootEventId: string,
	events: AkashaEvent[],
	predicate: (event: AkashaEvent) => boolean,
): AkashaEvent | undefined {
	const rootIndex = events.findIndex((event) => event.eventId === rootEventId);
	if (rootIndex < 0) return undefined;
	return events.find((event, index) => index > rootIndex && predicate(event));
}

function expectedPredictionOutcome(claim: string): "pass" | "fail" | undefined {
	const normalized = claim.toLowerCase();
	if (
		normalized.includes("should pass") ||
		normalized.includes("will pass") ||
		normalized.includes("likely pass") ||
		normalized.includes("should succeed") ||
		normalized.includes("green") ||
		claim.includes("应该通过") ||
		claim.includes("会通过") ||
		claim.includes("应该成功")
	) {
		return "pass";
	}
	if (
		normalized.includes("should fail") ||
		normalized.includes("will fail") ||
		normalized.includes("likely fail") ||
		normalized.includes("probably fail") ||
		claim.includes("应该失败") ||
		claim.includes("可能失败")
	) {
		return "fail";
	}
	return undefined;
}

function mentionsValidation(text: string): boolean {
	return (
		text.includes("test") ||
		text.includes("build") ||
		text.includes("lint") ||
		text.includes("tsc") ||
		text.includes("typecheck") ||
		text.includes("测试") ||
		text.includes("构建") ||
		text.includes("检查")
	);
}

function overlapsValidationIntent(text: string, command: string): boolean {
	const keywords = ["test", "vitest", "jest", "build", "lint", "tsc", "typecheck"];
	return (
		keywords.some((keyword) => text.includes(keyword) && command.includes(keyword)) || isValidationCommand(command)
	);
}

function isValidationCommand(command: string): boolean {
	return (
		command.includes("test") ||
		command.includes("vitest") ||
		command.includes("jest") ||
		command.includes("tsc") ||
		command.includes("build") ||
		command.includes("lint") ||
		command.includes("typecheck")
	);
}

function formatEvidence(event: AkashaEvent): string {
	const command = typeof event.payload.command === "string" ? event.payload.command : (event.objectId ?? event.kind);
	const outcome = event.payload.isError === true ? "failed" : "passed";
	return `${outcome}: ${command}`;
}
