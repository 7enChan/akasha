import { createHash } from "node:crypto";
import type { AkashaMemoryTrace } from "./memory-trace.js";
import { buildAkashaProceduralMemories } from "./procedural-memory.js";
import type { AkashaEvent } from "./types.js";

export type AkashaMemoryTraceEdgeKind =
	| "same_event"
	| "causal_parent"
	| "temporal_adjacent"
	| "same_artifact"
	| "same_tool"
	| "same_callback"
	| "same_entity"
	| "same_procedure"
	| "supports"
	| "contradicts"
	| "supersedes";

export type AkashaMemoryTraceEdgePolarity = "excitatory" | "inhibitory";

export interface AkashaMemoryTraceEdge {
	edgeId: string;
	fromTraceId: string;
	toTraceId: string;
	kind: AkashaMemoryTraceEdgeKind;
	weight: number;
	confidence: number;
	polarity: AkashaMemoryTraceEdgePolarity;
	sourceEventIds: string[];
	createdAt: string;
}

interface EdgeDraft {
	fromTrace: AkashaMemoryTrace;
	toTrace: AkashaMemoryTrace;
	kind: AkashaMemoryTraceEdgeKind;
	weight: number;
	confidence?: number;
	polarity?: AkashaMemoryTraceEdgePolarity;
	sourceEventIds?: string[];
}

const EDGE_LIMIT_PER_GROUP = 32;
const ENTITY_LIMIT_PER_TRACE = 8;

export function buildAkashaMemoryTraceEdges(
	events: AkashaEvent[],
	traces: AkashaMemoryTrace[],
): AkashaMemoryTraceEdge[] {
	const byEventId = new Map(events.map((event) => [event.eventId, event]));
	const tracesByEventId = groupTracesByEventId(traces);
	const edges = new Map<string, AkashaMemoryTraceEdge>();

	for (const group of tracesByEventId.values()) {
		addCompleteGroup(edges, group, "same_event", 0.9);
	}

	addCausalParentEdges(edges, events, tracesByEventId);
	addTemporalAdjacentEdges(edges, events, tracesByEventId);
	addSharedKeyEdges(edges, traces, byEventId, "same_artifact", 0.75, (trace, event) => artifactKeys(trace, event));
	addSharedKeyEdges(edges, traces, byEventId, "same_tool", 0.6, (trace, event) => toolKeys(trace, event));
	addSharedKeyEdges(edges, traces, byEventId, "same_callback", 0.85, (trace, event) => callbackKeys(trace, event));
	addSharedKeyEdges(edges, traces, byEventId, "same_entity", 0.45, (trace) => entityKeys(trace));
	addProcedureEdges(edges, events, traces);
	addSupportEdges(edges, traces, byEventId);
	addCorrectionEdges(edges, events, tracesByEventId);

	return [...edges.values()].sort((a, b) => a.edgeId.localeCompare(b.edgeId));
}

function addCausalParentEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	events: AkashaEvent[],
	tracesByEventId: Map<string, AkashaMemoryTrace[]>,
): void {
	for (const event of events) {
		const childTraces = tracesByEventId.get(event.eventId) ?? [];
		for (const parentId of event.parentEventIds) {
			const parentTraces = tracesByEventId.get(parentId) ?? [];
			addGroupEdges(edges, parentTraces, childTraces, "causal_parent", 0.8, { bidirectional: true });
		}
	}
}

function addTemporalAdjacentEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	events: AkashaEvent[],
	tracesByEventId: Map<string, AkashaMemoryTrace[]>,
): void {
	const ordered = [...events].sort(
		(a, b) =>
			a.streamId.localeCompare(b.streamId) || a.sequence - b.sequence || a.eventTime.localeCompare(b.eventTime),
	);
	for (let index = 1; index < ordered.length; index++) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (!previous || !current || previous.streamId !== current.streamId) continue;
		addGroupEdges(
			edges,
			tracesByEventId.get(previous.eventId) ?? [],
			tracesByEventId.get(current.eventId) ?? [],
			"temporal_adjacent",
			0.25,
			{ bidirectional: true, confidence: 0.65 },
		);
	}
}

function addSharedKeyEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	traces: AkashaMemoryTrace[],
	eventsById: Map<string, AkashaEvent>,
	kind: AkashaMemoryTraceEdgeKind,
	weight: number,
	keys: (trace: AkashaMemoryTrace, event: AkashaEvent | undefined) => string[],
): void {
	const groups = new Map<string, AkashaMemoryTrace[]>();
	for (const trace of traces) {
		const event = eventsById.get(trace.eventId);
		for (const key of keys(trace, event)) {
			const normalized = normalizeKey(key);
			if (!normalized) continue;
			const group = groups.get(normalized) ?? [];
			group.push(trace);
			groups.set(normalized, group);
		}
	}
	for (const group of groups.values()) addCompleteGroup(edges, group, kind, weight);
}

function addProcedureEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	events: AkashaEvent[],
	traces: AkashaMemoryTrace[],
): void {
	const tracesBySourceId = new Map<string, AkashaMemoryTrace[]>();
	for (const trace of traces) {
		for (const sourceId of trace.sourceEventIds) {
			const group = tracesBySourceId.get(sourceId) ?? [];
			group.push(trace);
			tracesBySourceId.set(sourceId, group);
		}
	}

	const procedures = buildAkashaProceduralMemories(events, { maxProcedures: 24 });
	for (const procedure of procedures) {
		const procedureTraces = uniqueTraces(
			procedure.sourceEventIds.flatMap((eventId) => tracesBySourceId.get(eventId) ?? []),
		);
		addCompleteGroup(edges, procedureTraces, "same_procedure", 0.7);
	}
}

function addSupportEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	traces: AkashaMemoryTrace[],
	eventsById: Map<string, AkashaEvent>,
): void {
	const relatedByKey = new Map<string, AkashaMemoryTrace[]>();
	for (const trace of traces) {
		const event = eventsById.get(trace.eventId);
		const keys = [
			...artifactKeys(trace, event),
			...toolKeys(trace, event),
			...callbackKeys(trace, event),
			...trace.sourceEventIds,
		];
		for (const key of keys.map(normalizeKey).filter((key): key is string => Boolean(key))) {
			const group = relatedByKey.get(key) ?? [];
			group.push(trace);
			relatedByKey.set(key, group);
		}
	}

	for (const group of relatedByKey.values()) {
		const supporters = group.filter(
			(trace) => trace.kind === "success" || trace.kind === "closure" || trace.kind === "skill",
		);
		const supported = group.filter(
			(trace) => trace.kind === "failure" || trace.kind === "task" || trace.kind === "callback",
		);
		addGroupEdges(edges, supporters, supported, "supports", 0.65, { bidirectional: true, confidence: 0.75 });
	}
}

function addCorrectionEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	events: AkashaEvent[],
	tracesByEventId: Map<string, AkashaMemoryTrace[]>,
): void {
	for (const event of events) {
		if (event.kind === "memory.reconsolidated") {
			const oldEventId = stringPayload(event, "oldMemoryEventId");
			const newEventId = stringPayload(event, "newMemoryEventId");
			if (!oldEventId || !newEventId) continue;
			const oldTraces = tracesByEventId.get(oldEventId) ?? [];
			const newTraces = tracesByEventId.get(newEventId) ?? [];
			addGroupEdges(edges, newTraces, oldTraces, "supersedes", 0.85, {
				confidence: 0.9,
				polarity: "inhibitory",
				sourceEventIds: [event.eventId, oldEventId, newEventId],
			});
			addGroupEdges(edges, oldTraces, newTraces, "supersedes", 0.85, {
				confidence: 0.9,
				polarity: "excitatory",
				sourceEventIds: [event.eventId, oldEventId, newEventId],
			});
			continue;
		}

		if (event.kind === "prediction.corrected") {
			const correctionTraces = tracesByEventId.get(event.eventId) ?? [];
			const targetEventIds = uniqueStrings([
				...event.parentEventIds,
				...stringArrayPayload(event, "sourceEventIds"),
			]);
			const targetTraces = uniqueTraces(targetEventIds.flatMap((eventId) => tracesByEventId.get(eventId) ?? []));
			addGroupEdges(edges, correctionTraces, targetTraces, "contradicts", 0.8, {
				confidence: 0.85,
				polarity: "inhibitory",
				sourceEventIds: [event.eventId, ...targetEventIds],
			});
			continue;
		}

		if (event.kind === "state.superseded") {
			const currentTraces = tracesByEventId.get(event.eventId) ?? [];
			const supersededIds = uniqueStrings([...event.parentEventIds, ...stringArrayPayload(event, "sourceEventIds")]);
			const supersededTraces = uniqueTraces(supersededIds.flatMap((eventId) => tracesByEventId.get(eventId) ?? []));
			addGroupEdges(edges, currentTraces, supersededTraces, "supersedes", 0.85, {
				confidence: 0.85,
				polarity: "inhibitory",
				sourceEventIds: [event.eventId, ...supersededIds],
			});
		}
	}
}

function addCompleteGroup(
	edges: Map<string, AkashaMemoryTraceEdge>,
	traces: AkashaMemoryTrace[],
	kind: AkashaMemoryTraceEdgeKind,
	weight: number,
): void {
	const group = uniqueTraces(traces).slice(0, EDGE_LIMIT_PER_GROUP);
	for (let left = 0; left < group.length; left++) {
		for (let right = left + 1; right < group.length; right++) {
			const fromTrace = group[left];
			const toTrace = group[right];
			if (!fromTrace || !toTrace) continue;
			addEdge(edges, { fromTrace, toTrace, kind, weight });
			addEdge(edges, { fromTrace: toTrace, toTrace: fromTrace, kind, weight });
		}
	}
}

function addGroupEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	fromTraces: AkashaMemoryTrace[],
	toTraces: AkashaMemoryTrace[],
	kind: AkashaMemoryTraceEdgeKind,
	weight: number,
	options: {
		bidirectional?: boolean;
		confidence?: number;
		polarity?: AkashaMemoryTraceEdgePolarity;
		sourceEventIds?: string[];
	} = {},
): void {
	for (const fromTrace of uniqueTraces(fromTraces).slice(0, EDGE_LIMIT_PER_GROUP)) {
		for (const toTrace of uniqueTraces(toTraces).slice(0, EDGE_LIMIT_PER_GROUP)) {
			if (fromTrace.traceId === toTrace.traceId) continue;
			addEdge(edges, {
				fromTrace,
				toTrace,
				kind,
				weight,
				confidence: options.confidence,
				polarity: options.polarity,
				sourceEventIds: options.sourceEventIds,
			});
			if (options.bidirectional) {
				addEdge(edges, {
					fromTrace: toTrace,
					toTrace: fromTrace,
					kind,
					weight,
					confidence: options.confidence,
					polarity: options.polarity,
					sourceEventIds: options.sourceEventIds,
				});
			}
		}
	}
}

function addEdge(edges: Map<string, AkashaMemoryTraceEdge>, draft: EdgeDraft): void {
	if (draft.fromTrace.traceId === draft.toTrace.traceId) return;
	const edge: AkashaMemoryTraceEdge = {
		edgeId: deterministicEdgeId(
			draft.kind,
			draft.fromTrace.traceId,
			draft.toTrace.traceId,
			draft.polarity ?? "excitatory",
		),
		fromTraceId: draft.fromTrace.traceId,
		toTraceId: draft.toTrace.traceId,
		kind: draft.kind,
		weight: clamp01(draft.weight),
		confidence: clamp01(draft.confidence ?? Math.min(draft.fromTrace.confidence, draft.toTrace.confidence)),
		polarity: draft.polarity ?? "excitatory",
		sourceEventIds: uniqueStrings([
			...(draft.sourceEventIds ?? []),
			...draft.fromTrace.sourceEventIds,
			...draft.toTrace.sourceEventIds,
		]),
		createdAt:
			draft.fromTrace.createdAt > draft.toTrace.createdAt ? draft.fromTrace.createdAt : draft.toTrace.createdAt,
	};
	const existing = edges.get(edge.edgeId);
	if (!existing || edge.weight * edge.confidence > existing.weight * existing.confidence) edges.set(edge.edgeId, edge);
}

function groupTracesByEventId(traces: AkashaMemoryTrace[]): Map<string, AkashaMemoryTrace[]> {
	const groups = new Map<string, AkashaMemoryTrace[]>();
	for (const trace of traces) {
		const group = groups.get(trace.eventId) ?? [];
		group.push(trace);
		groups.set(trace.eventId, group);
	}
	return groups;
}

function artifactKeys(trace: AkashaMemoryTrace, event: AkashaEvent | undefined): string[] {
	return uniqueStrings(
		[
			trace.kind === "artifact" ? trace.key : undefined,
			fileLike(trace.key),
			fileLike(trace.text),
			event?.objectId,
			stringPayload(event, "path"),
			stringPayload(event, "filePath"),
			stringPayload(event, "cwd"),
		].filter((value): value is string => Boolean(value)),
	);
}

function toolKeys(trace: AkashaMemoryTrace, event: AkashaEvent | undefined): string[] {
	return uniqueStrings(
		[
			trace.kind === "tool" ? trace.key : undefined,
			stringPayload(event, "toolName"),
			stringPayload(event, "command"),
			event?.kind.startsWith("tool.") ? event.subjectId : undefined,
		].filter((value): value is string => Boolean(value)),
	);
}

function callbackKeys(trace: AkashaMemoryTrace, event: AkashaEvent | undefined): string[] {
	return uniqueStrings(
		[
			trace.kind === "callback" || trace.kind === "closure" ? trace.key : undefined,
			stringPayload(event, "callbackId"),
			stringPayload(event, "targetEventId"),
			stringPayload(event, "inboxItemId"),
		].filter((value): value is string => Boolean(value)),
	);
}

function entityKeys(trace: AkashaMemoryTrace): string[] {
	const text = `${trace.key} ${trace.text}`;
	const keys = new Set<string>();

	for (const match of text.matchAll(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g)) addEntity(keys, match[0]);
	for (const match of text.matchAll(/"([^"]{2,80})"|'([^']{2,80})'/g)) addEntity(keys, match[1] ?? match[2]);
	for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*\b/g)) addEntity(keys, match[0]);
	for (const match of text.matchAll(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g)) addEntity(keys, match[0]);
	for (const match of text.matchAll(/\b[a-z0-9]+(?:[_-][a-z0-9]+)+\b/gi)) addEntity(keys, match[0]);
	for (const match of text.matchAll(/[\u4e00-\u9fff]{2,12}/gu)) addEntity(keys, match[0]);

	return [...keys].slice(0, ENTITY_LIMIT_PER_TRACE);
}

function addEntity(keys: Set<string>, value: string | undefined): void {
	const normalized = normalizeKey(value ?? "");
	if (!normalized || normalized.length < 2 || normalized.length > 90) return;
	if (GENERIC_ENTITY_KEYS.has(normalized)) return;
	keys.add(normalized);
}

const GENERIC_ENTITY_KEYS = new Set([
	"system",
	"user",
	"tool",
	"event",
	"trace",
	"memory",
	"callback",
	"summary",
	"reason",
	"source",
	"target",
]);

function fileLike(value: string): string | undefined {
	const match = value.match(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/);
	return match?.[0];
}

function deterministicEdgeId(
	kind: AkashaMemoryTraceEdgeKind,
	fromTraceId: string,
	toTraceId: string,
	polarity: AkashaMemoryTraceEdgePolarity,
): string {
	return `edge_${createHash("sha256").update(`${kind}:${polarity}:${fromTraceId}:${toTraceId}`).digest("hex").slice(0, 24)}`;
}

function stringPayload(event: AkashaEvent | undefined, key: string): string | undefined {
	const value = event?.payload[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayPayload(event: AkashaEvent | undefined, key: string): string[] {
	const value = event?.payload[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function normalizeKey(value: string): string | undefined {
	const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
	return normalized.length > 0 ? normalized : undefined;
}

function uniqueTraces(traces: AkashaMemoryTrace[]): AkashaMemoryTrace[] {
	return [...new Map(traces.map((trace) => [trace.traceId, trace])).values()].sort((a, b) =>
		a.traceId.localeCompare(b.traceId),
	);
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()))].sort();
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}
