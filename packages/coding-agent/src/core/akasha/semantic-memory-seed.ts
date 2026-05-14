import { indexAkashaEmbeddings } from "./embedding-indexer.js";
import type { AkashaEmbeddingProvider } from "./embedding-provider.js";
import type { AkashaEmbeddingStore } from "./embedding-store.js";
import type { AkashaEvent } from "./types.js";

export const SEMANTIC_SEED_LIMIT = 8;

export interface AkashaSemanticMemorySeed {
	eventId: string;
	score: number;
	similarity: number;
	reason: string;
}

export async function buildAkashaSemanticMemorySeeds(input: {
	events: AkashaEvent[];
	embeddingStore: AkashaEmbeddingStore;
	embeddingProvider: AkashaEmbeddingProvider;
	queryText?: string;
	limit?: number;
	indexLimit?: number;
	now?: () => string;
}): Promise<AkashaSemanticMemorySeed[]> {
	const queryText = input.queryText?.trim();
	if (!queryText) return [];

	const limit = Math.max(1, Math.floor(input.limit ?? SEMANTIC_SEED_LIMIT));
	const eventIds = new Set(input.events.map((event) => event.eventId));
	if (eventIds.size === 0) return [];

	await indexAkashaEmbeddings(input.events, input.embeddingStore, input.embeddingProvider, {
		limit: input.indexLimit,
		now: input.now,
	});
	const queryVector = await input.embeddingProvider.embed(queryText);
	const results = await input.embeddingStore.search(queryVector, {
		limit,
		targetTypes: ["event", "crystal"],
	});
	const seedsByEventId = new Map<string, AkashaSemanticMemorySeed>();
	for (const result of results) {
		if (result.similarity <= 0 || !eventIds.has(result.record.targetId)) continue;
		const seed = {
			eventId: result.record.targetId,
			score: Number(Math.min(0.65, result.similarity * 0.65).toFixed(4)),
			similarity: Number(result.similarity.toFixed(4)),
			reason: `embedding:${result.record.targetType}:${result.record.id}:${result.similarity.toFixed(4)}`,
		} satisfies AkashaSemanticMemorySeed;
		const existing = seedsByEventId.get(seed.eventId);
		if (!existing || compareSemanticSeed(seed, existing) < 0) {
			seedsByEventId.set(seed.eventId, seed);
		}
	}

	return [...seedsByEventId.values()].sort(compareSemanticSeed).slice(0, limit);
}

function compareSemanticSeed(left: AkashaSemanticMemorySeed, right: AkashaSemanticMemorySeed): number {
	return right.score - left.score || right.similarity - left.similarity || left.eventId.localeCompare(right.eventId);
}
