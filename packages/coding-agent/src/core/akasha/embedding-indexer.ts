import type { AkashaEmbeddingProvider } from "./embedding-provider.js";
import type { AkashaEmbeddingStore } from "./embedding-store.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaEmbeddingIndexOptions {
	limit?: number;
	now?: () => string;
}

export interface AkashaEmbeddingIndexResult {
	considered: number;
	indexed: number;
	skipped: number;
}

export async function indexAkashaEmbeddings(
	events: AkashaEvent[],
	store: AkashaEmbeddingStore,
	provider: AkashaEmbeddingProvider,
	options: AkashaEmbeddingIndexOptions = {},
): Promise<AkashaEmbeddingIndexResult> {
	const now = options.now ?? (() => new Date().toISOString());
	const candidates = [...events]
		.sort((a, b) => a.sequence - b.sequence)
		.filter(shouldIndexEvent)
		.slice(-(options.limit ?? Number.MAX_SAFE_INTEGER));
	let indexed = 0;
	let skipped = 0;

	for (const event of candidates) {
		const id = embeddingRecordId(event);
		if (store.has && (await store.has(id))) {
			skipped++;
			continue;
		}
		const text = eventEmbeddingText(event);
		if (!text) {
			skipped++;
			continue;
		}
		const vector = await provider.embed(text);
		await store.upsert({
			id,
			targetType: isCrystalEvent(event) ? "crystal" : "event",
			targetId: event.eventId,
			text,
			vector,
			createdAt: now(),
		});
		indexed++;
	}

	return {
		considered: candidates.length,
		indexed,
		skipped,
	};
}

export function embeddingRecordId(event: AkashaEvent): string {
	return `event:${event.eventId}:v${event.version}`;
}

export function eventEmbeddingText(event: AkashaEvent): string {
	const parts = [event.kind, event.objectId, payloadText(event)].filter(Boolean);
	return parts.join("\n").slice(0, 2000);
}

function shouldIndexEvent(event: AkashaEvent): boolean {
	return (
		event.kind !== "turn.started" &&
		event.kind !== "turn.completed" &&
		event.kind !== "tool.requested" &&
		event.kind !== "event.redacted"
	);
}

function isCrystalEvent(event: AkashaEvent): boolean {
	return (
		event.kind === "memory.crystal.created" ||
		event.kind === "memory.crystal.updated" ||
		event.kind === "failure.lesson_learned" ||
		event.kind === "preference.inferred" ||
		event.kind === "pattern.detected"
	);
}

function payloadText(event: AkashaEvent): string {
	const payload = event.payload;
	if (typeof payload.text === "string") return payload.text;
	if (typeof payload.summary === "string") return payload.summary;
	if (typeof payload.lesson === "string") return payload.lesson;
	if (typeof payload.preference === "string") return payload.preference;
	if (typeof payload.command === "string") return payload.command;
	if (typeof payload.path === "string") return payload.path;
	return JSON.stringify(payload);
}
