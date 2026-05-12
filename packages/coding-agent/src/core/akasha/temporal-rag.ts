import type { AkashaEmbeddingSearchResult, AkashaEmbeddingStore } from "./embedding-store.js";
import { buildOpenLoopLedger } from "./open-loops.js";
import { orderAkashaEvents } from "./ordering.js";
import { buildCausalIndex, findCausalPath } from "./projections.js";
import { scoreRecallEvent } from "./recall-policy.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaTemporalRagOptions {
	events: AkashaEvent[];
	embeddingStore: AkashaEmbeddingStore;
	queryVector: number[];
	queryText?: string;
	limit?: number;
	semanticLimit?: number;
	includeCausalParents?: boolean;
}

export interface AkashaTemporalRagMatch {
	event: AkashaEvent;
	similarity: number;
	score: number;
	reasons: string[];
}

export interface AkashaTemporalRagResult {
	events: AkashaEvent[];
	matches: AkashaTemporalRagMatch[];
}

export async function retrieveTemporalContext(options: AkashaTemporalRagOptions): Promise<AkashaTemporalRagResult> {
	const limit = Math.max(1, Math.floor(options.limit ?? 12));
	const semanticLimit = Math.max(limit, Math.floor(options.semanticLimit ?? limit * 4));
	const byId = new Map(options.events.map((event) => [event.eventId, event]));
	const searchResults = await options.embeddingStore.search(options.queryVector, {
		limit: semanticLimit,
		targetTypes: ["event", "crystal"],
	});
	const ledger = buildOpenLoopLedger(options.events);
	const unresolvedRootIds = new Set(
		ledger.filter((loop) => loop.state !== "resolved").map((loop) => loop.rootEventId),
	);
	const resolvedRootIds = new Set(ledger.filter((loop) => loop.state === "resolved").map((loop) => loop.rootEventId));

	const matches = searchResults
		.map((result) => matchEvent(result, byId, unresolvedRootIds, resolvedRootIds, options.queryText))
		.filter((match): match is AkashaTemporalRagMatch => !!match)
		.sort((a, b) => b.score - a.score || b.event.sequence - a.event.sequence);

	const selected = new Map<string, AkashaEvent>();
	const causalIndex = buildCausalIndex(options.events);
	for (const match of matches.slice(0, limit)) {
		const expanded =
			options.includeCausalParents === false ? [match.event] : findCausalPath(causalIndex, match.event.eventId);
		for (const event of expanded) {
			selected.set(event.eventId, event);
		}
	}

	return {
		events: orderAkashaEvents([...selected.values()]),
		matches: matches.slice(0, limit),
	};
}

function matchEvent(
	result: AkashaEmbeddingSearchResult,
	byId: Map<string, AkashaEvent>,
	unresolvedRootIds: Set<string>,
	resolvedRootIds: Set<string>,
	queryText: string | undefined,
): AkashaTemporalRagMatch | undefined {
	const event = byId.get(result.record.targetId);
	if (!event) return undefined;
	const reasons = ["semantic"];
	let score = result.similarity * 10 + scoreRecallEvent(event, queryText);

	if (event.kind === "tool.completed" && event.payload.isError === true) {
		score += 12;
		reasons.push("failed_tool");
	}
	if (unresolvedRootIds.has(event.eventId)) {
		score += 10;
		reasons.push("unresolved_loop");
	}
	if (resolvedRootIds.has(event.eventId) || event.kind === "loop.resolved") {
		score -= 8;
		reasons.push("resolved_or_stale");
	}
	if (event.kind === "failure.lesson_learned" || event.kind === "memory.crystal.created") {
		score += 8;
		reasons.push("crystal");
	}

	return { event, similarity: result.similarity, score, reasons };
}
