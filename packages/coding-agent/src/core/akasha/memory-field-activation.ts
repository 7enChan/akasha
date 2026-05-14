import type { AkashaMemoryCue } from "./memory-cue.js";
import { type AkashaMemoryTraceScore, scoreAkashaMemoryTrace } from "./memory-resonance.js";
import type { AkashaMemoryTrace } from "./memory-trace.js";
import type { AkashaMemoryTraceEdge, AkashaMemoryTraceEdgeKind } from "./memory-trace-edge.js";
import type { AkashaSemanticMemorySeed } from "./semantic-memory-seed.js";

export interface AkashaMemoryActivationPath {
	fromTraceId: string;
	toTraceId: string;
	edgeId: string;
	edgeKind: AkashaMemoryTraceEdgeKind;
	hop: number;
	delta: number;
}

export interface AkashaMemoryFieldActivationCluster {
	clusterId: string;
	traceIds: string[];
	edgeIds: string[];
	score: number;
	reasons: string[];
}

export interface AkashaMemoryFieldActivationResult {
	scores: AkashaMemoryTraceScore[];
	activatedEdgeIds: string[];
	activationPaths: AkashaMemoryActivationPath[];
	clusters: AkashaMemoryFieldActivationCluster[];
}

export interface AkashaMemoryFieldActivationOptions {
	maxResults?: number;
	now?: Date;
	semanticSeeds?: AkashaSemanticMemorySeed[];
}

interface FrontierItem {
	traceId: string;
	score: number;
}

interface InitialSeed {
	trace: AkashaMemoryTrace;
	score: number;
	reasons: string[];
	canSpread: boolean;
}

const HOP_DECAY = new Map<number, number>([
	[1, 0.55],
	[2, 0.3],
]);

export function activateAkashaMemoryField(
	traces: AkashaMemoryTrace[],
	edges: AkashaMemoryTraceEdge[],
	cue: AkashaMemoryCue,
	options: AkashaMemoryFieldActivationOptions = {},
): AkashaMemoryFieldActivationResult {
	const maxResults = options.maxResults ?? 24;
	const traceById = new Map(traces.map((trace) => [trace.traceId, trace]));
	const directSeedScores = traces
		.map((trace) => scoreAkashaMemoryTrace(trace, cue, options))
		.filter((score) => score.score > 0);
	const seedScores = mergeInitialSeeds([
		...directSeedScores.map((seed) => ({
			trace: seed.trace,
			score: seedActivationScore(seed),
			reasons: seed.reasons,
			canSpread: seedCanSpread(seed),
		})),
		...semanticSeedScores(traces, options.semanticSeeds ?? []).map((seed) => ({
			trace: seed.trace,
			score: seed.score,
			reasons: seed.reasons,
			canSpread: true,
		})),
	]);
	const activation = new Map<string, number>();
	const reasons = new Map<string, string[]>();
	const outgoing = groupEdgesByFromTrace(edges, traceById);
	const activatedEdgeIds = new Set<string>();
	const activationPaths: AkashaMemoryActivationPath[] = [];
	const inhibition = new Map<string, number>();

	let frontier: FrontierItem[] = seedScores.map((seed) => {
		activation.set(seed.trace.traceId, seed.score);
		reasons.set(seed.trace.traceId, uniqueStrings(seed.reasons.map((reason) => `seed:${reason}`)));
		return { traceId: seed.trace.traceId, score: seed.canSpread ? seed.score : 0 };
	});

	for (let hop = 1; hop <= 2; hop++) {
		const hopDecay = HOP_DECAY.get(hop) ?? 0;
		const nextFrontier = new Map<string, number>();
		for (const item of frontier) {
			if (item.score <= 0) continue;
			for (const edge of outgoing.get(item.traceId) ?? []) {
				const target = traceById.get(edge.toTraceId);
				if (!target) continue;
				const magnitude = item.score * edge.weight * edge.confidence * kindDecay(edge.kind) * hopDecay;
				if (magnitude <= 0.0001) continue;
				const delta = edge.polarity === "inhibitory" ? -magnitude : magnitude;
				const previous = activation.get(edge.toTraceId) ?? 0;
				const next = Math.max(0, previous + delta);
				activation.set(edge.toTraceId, next);
				if (delta < 0) inhibition.set(edge.toTraceId, (inhibition.get(edge.toTraceId) ?? 0) + magnitude);
				activatedEdgeIds.add(edge.edgeId);
				activationPaths.push({
					fromTraceId: edge.fromTraceId,
					toTraceId: edge.toTraceId,
					edgeId: edge.edgeId,
					edgeKind: edge.kind,
					hop,
					delta: Number(delta.toFixed(4)),
				});
				addReason(reasons, edge.toTraceId, `field:${edge.kind}:${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`);
				if (delta > 0 && next > previous) {
					nextFrontier.set(edge.toTraceId, Math.max(nextFrontier.get(edge.toTraceId) ?? 0, magnitude));
				}
			}
		}
		frontier = [...nextFrontier.entries()].map(([traceId, score]) => ({ traceId, score }));
	}

	const scores = [...activation.entries()]
		.map(([traceId, score]) => {
			const trace = traceById.get(traceId);
			if (!trace) return undefined;
			const finalScore = Math.max(0, score - (inhibition.get(traceId) ?? 0));
			return {
				trace,
				score: Number(finalScore.toFixed(4)),
				reasons: reasons.get(traceId) ?? ["field_activation"],
			} satisfies AkashaMemoryTraceScore;
		})
		.filter((score): score is AkashaMemoryTraceScore => score !== undefined && score.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score ||
				b.trace.createdAt.localeCompare(a.trace.createdAt) ||
				a.trace.traceId.localeCompare(b.trace.traceId),
		)
		.slice(0, maxResults);
	const selectedTraceIds = new Set(scores.map((score) => score.trace.traceId));
	const selectedEdgeIds = [...activatedEdgeIds].filter((edgeId) => {
		const edge = edges.find((candidate) => candidate.edgeId === edgeId);
		return edge ? selectedTraceIds.has(edge.fromTraceId) && selectedTraceIds.has(edge.toTraceId) : false;
	});

	return {
		scores,
		activatedEdgeIds: selectedEdgeIds.sort(),
		activationPaths: activationPaths.sort(
			(a, b) => a.hop - b.hop || Math.abs(b.delta) - Math.abs(a.delta) || a.edgeId.localeCompare(b.edgeId),
		),
		clusters: buildClusters(scores, edges, selectedEdgeIds, reasons),
	};
}

function groupEdgesByFromTrace(
	edges: AkashaMemoryTraceEdge[],
	traceById: Map<string, AkashaMemoryTrace>,
): Map<string, AkashaMemoryTraceEdge[]> {
	const grouped = new Map<string, AkashaMemoryTraceEdge[]>();
	for (const edge of edges) {
		if (!traceById.has(edge.fromTraceId) || !traceById.has(edge.toTraceId)) continue;
		const group = grouped.get(edge.fromTraceId) ?? [];
		group.push(edge);
		grouped.set(edge.fromTraceId, group);
	}
	for (const group of grouped.values()) {
		group.sort((a, b) => b.weight * b.confidence - a.weight * a.confidence || a.edgeId.localeCompare(b.edgeId));
	}
	return grouped;
}

function semanticSeedScores(
	traces: AkashaMemoryTrace[],
	semanticSeeds: AkashaSemanticMemorySeed[],
): AkashaMemoryTraceScore[] {
	if (semanticSeeds.length === 0) return [];
	const seedsByEventId = new Map<string, AkashaSemanticMemorySeed>();
	for (const seed of semanticSeeds) {
		if (seed.score <= 0) continue;
		const existing = seedsByEventId.get(seed.eventId);
		if (!existing || compareSemanticSeed(seed, existing) < 0) seedsByEventId.set(seed.eventId, seed);
	}
	if (seedsByEventId.size === 0) return [];
	return traces
		.map((trace) => {
			const seed = bestSemanticSeedForTrace(trace, seedsByEventId);
			if (!seed) return undefined;
			return {
				trace,
				score: seed.score,
				reasons: [`semantic:${seed.eventId}:${seed.score.toFixed(2)}`],
			} satisfies AkashaMemoryTraceScore;
		})
		.filter((score): score is AkashaMemoryTraceScore => score !== undefined);
}

function bestSemanticSeedForTrace(
	trace: AkashaMemoryTrace,
	seedsByEventId: Map<string, AkashaSemanticMemorySeed>,
): AkashaSemanticMemorySeed | undefined {
	let best = seedsByEventId.get(trace.eventId);
	for (const eventId of trace.sourceEventIds) {
		const seed = seedsByEventId.get(eventId);
		if (seed && (!best || compareSemanticSeed(seed, best) < 0)) best = seed;
	}
	return best;
}

function mergeInitialSeeds(seeds: InitialSeed[]): InitialSeed[] {
	const byTraceId = new Map<string, InitialSeed>();
	for (const seed of seeds) {
		const existing = byTraceId.get(seed.trace.traceId);
		if (!existing) {
			byTraceId.set(seed.trace.traceId, {
				trace: seed.trace,
				score: seed.score,
				reasons: uniqueStrings(seed.reasons),
				canSpread: seed.canSpread,
			});
			continue;
		}
		existing.score += seed.score;
		existing.reasons = uniqueStrings([...existing.reasons, ...seed.reasons]);
		existing.canSpread ||= seed.canSpread;
	}
	return [...byTraceId.values()];
}

function buildClusters(
	scores: AkashaMemoryTraceScore[],
	edges: AkashaMemoryTraceEdge[],
	selectedEdgeIds: string[],
	reasonsByTraceId: Map<string, string[]>,
): AkashaMemoryFieldActivationCluster[] {
	const selectedTraceIds = new Set(scores.map((score) => score.trace.traceId));
	const parent = new Map([...selectedTraceIds].map((traceId) => [traceId, traceId]));
	const selectedEdgeIdSet = new Set(selectedEdgeIds);
	for (const edge of edges) {
		if (!selectedEdgeIdSet.has(edge.edgeId)) continue;
		if (!selectedTraceIds.has(edge.fromTraceId) || !selectedTraceIds.has(edge.toTraceId)) continue;
		union(parent, edge.fromTraceId, edge.toTraceId);
	}

	const byRoot = new Map<string, { traceIds: string[]; edgeIds: string[]; score: number; reasons: string[] }>();
	const scoreByTraceId = new Map(scores.map((score) => [score.trace.traceId, score.score]));
	for (const traceId of selectedTraceIds) {
		const root = find(parent, traceId);
		const group = byRoot.get(root) ?? { traceIds: [], edgeIds: [], score: 0, reasons: [] };
		group.traceIds.push(traceId);
		group.score += scoreByTraceId.get(traceId) ?? 0;
		group.reasons.push(...(reasonsByTraceId.get(traceId) ?? []));
		byRoot.set(root, group);
	}
	for (const edge of edges) {
		if (!selectedEdgeIdSet.has(edge.edgeId)) continue;
		const root = find(parent, edge.fromTraceId);
		const group = byRoot.get(root);
		if (group) group.edgeIds.push(edge.edgeId);
	}

	return [...byRoot.entries()]
		.map(([root, group]) => ({
			clusterId: `cluster_${root.slice("trace_".length, "trace_".length + 16)}`,
			traceIds: uniqueStrings(group.traceIds),
			edgeIds: uniqueStrings(group.edgeIds),
			score: Number(group.score.toFixed(4)),
			reasons: uniqueStrings(group.reasons).slice(0, 8),
		}))
		.sort((a, b) => b.score - a.score || a.clusterId.localeCompare(b.clusterId));
}

function kindDecay(kind: AkashaMemoryTraceEdgeKind): number {
	if (kind === "same_event") return 0.75;
	if (kind === "causal_parent") return 0.85;
	if (kind === "temporal_adjacent") return 0.35;
	if (kind === "same_artifact") return 0.9;
	if (kind === "same_tool") return 0.7;
	if (kind === "same_callback") return 0.9;
	if (kind === "same_entity") return 0.5;
	if (kind === "same_procedure") return 0.8;
	if (kind === "supports") return 0.75;
	return 0.85;
}

function seedActivationScore(seed: AkashaMemoryTraceScore): number {
	if (seed.reasons.length === 1 && seed.reasons[0] === "baseline_weight") return seed.score * 0.15;
	return seed.score;
}

function seedCanSpread(seed: AkashaMemoryTraceScore): boolean {
	return !(seed.reasons.length === 1 && seed.reasons[0] === "baseline_weight");
}

function addReason(reasons: Map<string, string[]>, traceId: string, reason: string): void {
	reasons.set(traceId, uniqueStrings([...(reasons.get(traceId) ?? []), reason]));
}

function union(parent: Map<string, string>, left: string, right: string): void {
	parent.set(find(parent, right), find(parent, left));
}

function find(parent: Map<string, string>, traceId: string): string {
	const current = parent.get(traceId) ?? traceId;
	if (current === traceId) return current;
	const root = find(parent, current);
	parent.set(traceId, root);
	return root;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.trim()))].sort();
}

function compareSemanticSeed(left: AkashaSemanticMemorySeed, right: AkashaSemanticMemorySeed): number {
	return right.score - left.score || right.similarity - left.similarity || left.eventId.localeCompare(right.eventId);
}
