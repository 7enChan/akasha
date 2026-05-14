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

const EDGE_LIMIT_PER_GROUP = 24;
const ENTITY_LIMIT_PER_TRACE = 8;
const MAX_MEMORY_TRACE_EDGES = 4096;
const EDGE_SOURCE_EVENT_ID_LIMIT = 12;

const EDGE_LIMIT_PER_KIND: Record<AkashaMemoryTraceEdgeKind, number> = {
	same_event: 512,
	causal_parent: 768,
	temporal_adjacent: 512,
	same_artifact: 512,
	same_tool: 256,
	same_callback: 256,
	same_entity: 512,
	same_procedure: 256,
	supports: 256,
	contradicts: 128,
	supersedes: 128,
};

interface EdgeBudget {
	total: number;
	byKind: Map<AkashaMemoryTraceEdgeKind, number>;
}

export function buildAkashaMemoryTraceEdges(
	events: AkashaEvent[],
	traces: AkashaMemoryTrace[],
): AkashaMemoryTraceEdge[] {
	const byEventId = new Map(events.map((event) => [event.eventId, event]));
	const tracesByEventId = groupTracesByEventId(traces);
	const edges = new Map<string, AkashaMemoryTraceEdge>();
	const budget: EdgeBudget = { total: 0, byKind: new Map() };

	for (const group of tracesByEventId.values()) {
		addCompleteGroup(edges, budget, group, "same_event", 0.9);
	}

	addCausalParentEdges(edges, budget, events, tracesByEventId);
	addTemporalAdjacentEdges(edges, budget, events, tracesByEventId);
	addSharedKeyEdges(edges, budget, traces, byEventId, "same_artifact", 0.75, (trace, event) =>
		artifactKeys(trace, event),
	);
	addSharedKeyEdges(edges, budget, traces, byEventId, "same_tool", 0.6, (trace, event) => toolKeys(trace, event));
	addSharedKeyEdges(edges, budget, traces, byEventId, "same_callback", 0.85, (trace, event) =>
		callbackKeys(trace, event),
	);
	addSharedKeyEdges(edges, budget, traces, byEventId, "same_entity", 0.45, (trace) => entityKeys(trace));
	addProcedureEdges(edges, budget, events, traces);
	addSupportEdges(edges, budget, traces, byEventId);
	addCorrectionEdges(edges, budget, events, tracesByEventId);

	return [...edges.values()].sort((a, b) => a.edgeId.localeCompare(b.edgeId));
}

function addCausalParentEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	budget: EdgeBudget,
	events: AkashaEvent[],
	tracesByEventId: Map<string, AkashaMemoryTrace[]>,
): void {
	for (const event of events) {
		if (isKindBudgetFull(budget, "causal_parent")) break;
		const childTraces = tracesByEventId.get(event.eventId) ?? [];
		for (const parentId of event.parentEventIds) {
			if (isKindBudgetFull(budget, "causal_parent")) break;
			const parentTraces = tracesByEventId.get(parentId) ?? [];
			addGroupEdges(edges, budget, parentTraces, childTraces, "causal_parent", 0.8, { bidirectional: true });
		}
	}
}

function addTemporalAdjacentEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	budget: EdgeBudget,
	events: AkashaEvent[],
	tracesByEventId: Map<string, AkashaMemoryTrace[]>,
): void {
	const ordered = [...events].sort(
		(a, b) =>
			a.streamId.localeCompare(b.streamId) || a.sequence - b.sequence || a.eventTime.localeCompare(b.eventTime),
	);
	for (let index = 1; index < ordered.length; index++) {
		if (isKindBudgetFull(budget, "temporal_adjacent")) break;
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (!previous || !current || previous.streamId !== current.streamId) continue;
		addGroupEdges(
			edges,
			budget,
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
	budget: EdgeBudget,
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
	for (const group of groups.values()) {
		if (isKindBudgetFull(budget, kind)) break;
		addCompleteGroup(edges, budget, group, kind, weight);
	}
}

function addProcedureEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	budget: EdgeBudget,
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
		if (isKindBudgetFull(budget, "same_procedure")) break;
		const procedureTraces = uniqueTraces(
			procedure.sourceEventIds.flatMap((eventId) => tracesBySourceId.get(eventId) ?? []),
		);
		addCompleteGroup(edges, budget, procedureTraces, "same_procedure", 0.7);
	}
}

function addSupportEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	budget: EdgeBudget,
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
		if (isKindBudgetFull(budget, "supports")) break;
		const supporters = group.filter(
			(trace) => trace.kind === "success" || trace.kind === "closure" || trace.kind === "skill",
		);
		const supported = group.filter(
			(trace) => trace.kind === "failure" || trace.kind === "task" || trace.kind === "callback",
		);
		addGroupEdges(edges, budget, supporters, supported, "supports", 0.65, {
			bidirectional: true,
			confidence: 0.75,
		});
	}
}

function addCorrectionEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	budget: EdgeBudget,
	events: AkashaEvent[],
	tracesByEventId: Map<string, AkashaMemoryTrace[]>,
): void {
	for (const event of events) {
		if (event.kind === "memory.reconsolidated") {
			const oldEventId = stringPayload(event, "oldMemoryEventId");
			const newEventId = stringPayload(event, "newMemoryEventId");
			if (!oldEventId || !newEventId) continue;
			if (isKindBudgetFull(budget, "supersedes")) continue;
			const oldTraces = tracesByEventId.get(oldEventId) ?? [];
			const newTraces = tracesByEventId.get(newEventId) ?? [];
			addGroupEdges(edges, budget, newTraces, oldTraces, "supersedes", 0.85, {
				confidence: 0.9,
				polarity: "inhibitory",
				sourceEventIds: [event.eventId, oldEventId, newEventId],
			});
			addGroupEdges(edges, budget, oldTraces, newTraces, "supersedes", 0.85, {
				confidence: 0.9,
				polarity: "excitatory",
				sourceEventIds: [event.eventId, oldEventId, newEventId],
			});
			continue;
		}

		if (event.kind === "prediction.corrected") {
			if (isKindBudgetFull(budget, "contradicts")) continue;
			const correctionTraces = tracesByEventId.get(event.eventId) ?? [];
			const targetEventIds = uniqueStrings([
				...event.parentEventIds,
				...stringArrayPayload(event, "sourceEventIds"),
			]);
			const targetTraces = uniqueTraces(targetEventIds.flatMap((eventId) => tracesByEventId.get(eventId) ?? []));
			addGroupEdges(edges, budget, correctionTraces, targetTraces, "contradicts", 0.8, {
				confidence: 0.85,
				polarity: "inhibitory",
				sourceEventIds: [event.eventId, ...targetEventIds],
			});
			continue;
		}

		if (event.kind === "state.superseded") {
			if (isKindBudgetFull(budget, "supersedes")) continue;
			const currentTraces = tracesByEventId.get(event.eventId) ?? [];
			const supersededIds = uniqueStrings([...event.parentEventIds, ...stringArrayPayload(event, "sourceEventIds")]);
			const supersededTraces = uniqueTraces(supersededIds.flatMap((eventId) => tracesByEventId.get(eventId) ?? []));
			addGroupEdges(edges, budget, currentTraces, supersededTraces, "supersedes", 0.85, {
				confidence: 0.85,
				polarity: "inhibitory",
				sourceEventIds: [event.eventId, ...supersededIds],
			});
		}
	}
}

function addCompleteGroup(
	edges: Map<string, AkashaMemoryTraceEdge>,
	budget: EdgeBudget,
	traces: AkashaMemoryTrace[],
	kind: AkashaMemoryTraceEdgeKind,
	weight: number,
): void {
	const group = selectTraces(traces, EDGE_LIMIT_PER_GROUP);
	for (let left = 0; left < group.length; left++) {
		if (isKindBudgetFull(budget, kind)) break;
		for (let right = left + 1; right < group.length; right++) {
			if (isKindBudgetFull(budget, kind)) break;
			const fromTrace = group[left];
			const toTrace = group[right];
			if (!fromTrace || !toTrace) continue;
			addEdge(edges, budget, { fromTrace, toTrace, kind, weight });
			addEdge(edges, budget, { fromTrace: toTrace, toTrace: fromTrace, kind, weight });
		}
	}
}

function addGroupEdges(
	edges: Map<string, AkashaMemoryTraceEdge>,
	budget: EdgeBudget,
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
	const fromGroup = selectTraces(fromTraces, EDGE_LIMIT_PER_GROUP);
	const toGroup = selectTraces(toTraces, EDGE_LIMIT_PER_GROUP);
	for (const fromTrace of fromGroup) {
		if (isKindBudgetFull(budget, kind)) break;
		for (const toTrace of toGroup) {
			if (isKindBudgetFull(budget, kind)) break;
			if (fromTrace.traceId === toTrace.traceId) continue;
			addEdge(edges, budget, {
				fromTrace,
				toTrace,
				kind,
				weight,
				confidence: options.confidence,
				polarity: options.polarity,
				sourceEventIds: options.sourceEventIds,
			});
			if (options.bidirectional) {
				addEdge(edges, budget, {
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

function addEdge(edges: Map<string, AkashaMemoryTraceEdge>, budget: EdgeBudget, draft: EdgeDraft): void {
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
		]).slice(0, EDGE_SOURCE_EVENT_ID_LIMIT),
		createdAt:
			draft.fromTrace.createdAt > draft.toTrace.createdAt ? draft.fromTrace.createdAt : draft.toTrace.createdAt,
	};
	const existing = edges.get(edge.edgeId);
	if (existing) {
		if (edge.weight * edge.confidence > existing.weight * existing.confidence) edges.set(edge.edgeId, edge);
		return;
	}
	if (isKindBudgetFull(budget, edge.kind)) return;
	edges.set(edge.edgeId, edge);
	budget.total++;
	budget.byKind.set(edge.kind, (budget.byKind.get(edge.kind) ?? 0) + 1);
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

function selectTraces(traces: AkashaMemoryTrace[], limit: number): AkashaMemoryTrace[] {
	return uniqueTraces(traces)
		.sort(
			(a, b) =>
				tracePriority(b) - tracePriority(a) ||
				b.createdAt.localeCompare(a.createdAt) ||
				a.traceId.localeCompare(b.traceId),
		)
		.slice(0, limit);
}

function tracePriority(trace: AkashaMemoryTrace): number {
	return trace.weight * trace.confidence;
}

function isKindBudgetFull(budget: EdgeBudget, kind: AkashaMemoryTraceEdgeKind): boolean {
	return budget.total >= MAX_MEMORY_TRACE_EDGES || (budget.byKind.get(kind) ?? 0) >= EDGE_LIMIT_PER_KIND[kind];
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()))].sort();
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}
