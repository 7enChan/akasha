import { orderAkashaEvents } from "./ordering.js";
import { buildTemporalState } from "./temporal-state.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";
import { validationCoversArtifact } from "./validation.js";

export interface AkashaOpenLoopRecord {
	loopKey: string;
	rootEventId: string;
	reason: string;
	summary: string;
	state: "open" | "resolved" | "blocked";
	openedEventId?: string;
	resolvedEventId?: string;
	objectId?: string;
	toolCallId?: string;
}

export function buildOpenLoopLedger(events: AkashaEvent[]): AkashaOpenLoopRecord[] {
	const byKey = new Map<string, AkashaOpenLoopRecord>();
	for (const event of orderAkashaEvents(events)) {
		if (event.kind === "loop.opened") {
			const loopKey = loopKeyFromPayload(event);
			if (!loopKey) continue;
			byKey.set(loopKey, {
				loopKey,
				rootEventId: stringPayload(event, "rootEventId") ?? event.parentEventIds[0] ?? event.eventId,
				reason: stringPayload(event, "reason") ?? "unknown",
				summary: stringPayload(event, "summary") ?? "Open loop",
				state: "open",
				openedEventId: event.eventId,
				objectId: event.objectId,
				toolCallId: event.toolCallId,
			});
		}
		if (event.kind === "loop.blocked" || event.kind === "loop.resolved") {
			const loopKey = loopKeyFromPayload(event);
			if (!loopKey) continue;
			const existing = byKey.get(loopKey);
			if (!existing) continue;
			byKey.set(loopKey, {
				...existing,
				state: event.kind === "loop.resolved" ? "resolved" : "blocked",
				resolvedEventId: event.kind === "loop.resolved" ? event.eventId : existing.resolvedEventId,
			});
		}
	}
	return [...byKey.values()].sort((a, b) => a.loopKey.localeCompare(b.loopKey));
}

export function deriveOpenLoopEvents(events: AkashaEvent[], sessionId: string, streamId: string): AkashaEventDraft[] {
	const ordered = orderAkashaEvents(events);
	const state = buildTemporalState(ordered);
	const ledger = buildOpenLoopLedger(ordered);
	const existingKeys = new Set(ledger.map((record) => record.loopKey));
	const drafts: AkashaEventDraft[] = [];

	for (const candidate of state.openLoopCandidates) {
		const loopKey = makeLoopKey(candidate.rootEventId, candidate.reason);
		if (existingKeys.has(loopKey)) continue;
		drafts.push({
			kind: "loop.opened",
			sessionId,
			streamId,
			eventTime: new Date().toISOString(),
			actor: "system",
			subjectId: "akasha",
			objectId: candidate.objectId,
			toolCallId: candidate.toolCallId,
			sourceKey: `open-loop:${loopKey}`,
			parentEventIds: [candidate.rootEventId],
			payload: {
				loopKey,
				reason: candidate.reason,
				summary: candidate.summary,
				rootEventId: candidate.rootEventId,
				state: "open",
			},
			importance: 0.85,
			ttlPolicy: "long_term",
		});
	}

	for (const record of ledger) {
		if (record.state !== "open") continue;
		const root = ordered.find((event) => event.eventId === record.rootEventId);
		if (!root) continue;
		const resolver = findResolverForLoop(record, root, ordered);
		if (!resolver) continue;
		drafts.push({
			kind: "loop.resolved",
			sessionId,
			streamId,
			eventTime: resolver.eventTime,
			actor: "system",
			subjectId: "akasha",
			objectId: record.objectId,
			toolCallId: record.toolCallId,
			sourceKey: `open-loop-resolved:${record.loopKey}:${resolver.eventId}`,
			parentEventIds: [record.openedEventId ?? record.rootEventId, resolver.eventId],
			payload: {
				loopKey: record.loopKey,
				reason: record.reason,
				summary: `Resolved: ${record.summary}`,
				rootEventId: record.rootEventId,
				resolverEventId: resolver.eventId,
				state: "resolved",
			},
			importance: 0.7,
			ttlPolicy: "long_term",
		});
	}

	return drafts;
}

function findResolverForLoop(
	record: AkashaOpenLoopRecord,
	root: AkashaEvent,
	ordered: AkashaEvent[],
): AkashaEvent | undefined {
	const rootIndex = ordered.findIndex((event) => event.eventId === root.eventId);
	const isAfterRoot = (event: AkashaEvent): boolean =>
		ordered.findIndex((item) => item.eventId === event.eventId) > rootIndex;
	if (record.reason === "artifact_changed_without_validation") {
		const knownPaths = ordered.flatMap((event) => {
			const path = event.objectId ?? stringPayload(event, "path");
			return path ? [path] : [];
		});
		return ordered.find(
			(event) =>
				isAfterRoot(event) &&
				event.kind === "command.executed" &&
				!!record.objectId &&
				validationCoversArtifact(event, record.objectId, knownPaths),
		);
	}

	if (record.reason === "tool_failed_without_recovery") {
		const toolName = typeof root.payload.toolName === "string" ? root.payload.toolName : root.objectId;
		return ordered.find(
			(event) =>
				isAfterRoot(event) &&
				event.kind === "tool.completed" &&
				event.payload.isError !== true &&
				(!toolName || event.payload.toolName === toolName || event.objectId === toolName),
		);
	}

	if (record.reason === "prediction_due") {
		const predictionId = record.loopKey.endsWith(":prediction_due")
			? record.loopKey.slice(0, -":prediction_due".length)
			: undefined;
		return ordered.find(
			(event) =>
				isAfterRoot(event) &&
				(event.kind === "prediction.checked" || event.kind === "prediction.corrected") &&
				(!predictionId || event.payload.predictionId === predictionId),
		);
	}

	return undefined;
}

function makeLoopKey(rootEventId: string, reason: string): string {
	return `${rootEventId}:${reason}`;
}

function loopKeyFromPayload(event: AkashaEvent): string | undefined {
	const loopKey = stringPayload(event, "loopKey");
	if (loopKey) return loopKey;
	const rootEventId = stringPayload(event, "rootEventId") ?? event.parentEventIds[0];
	const reason = stringPayload(event, "reason");
	return rootEventId && reason ? makeLoopKey(rootEventId, reason) : undefined;
}

function stringPayload(event: AkashaEvent, key: string): string | undefined {
	return typeof event.payload[key] === "string" ? event.payload[key] : undefined;
}
