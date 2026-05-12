import { createCrystalDrafts, toMemoryCrystalDraft } from "./crystals.js";
import type { AkashaEvent, AkashaStore } from "./types.js";

export interface AkashaReflectionPassOptions {
	sessionId?: string;
	streamId?: string;
	limit?: number;
	now?: () => string;
}

export interface AkashaReflectionPassResult {
	started: AkashaEvent;
	crystals: AkashaEvent[];
	memoryCrystals: AkashaEvent[];
	completed: AkashaEvent;
}

export function runReflectionPass(
	store: AkashaStore,
	options: AkashaReflectionPassOptions = {},
): AkashaReflectionPassResult {
	const events = store.buildTimeline({ limit: options.limit ?? 500 });
	const sessionId = options.sessionId ?? events.at(-1)?.sessionId ?? "unknown";
	const streamId = options.streamId ?? events.at(-1)?.streamId ?? `session:${sessionId}`;
	const now = options.now?.() ?? new Date().toISOString();
	const parentEventIds = events.length > 0 ? [events[events.length - 1]!.eventId] : [];

	const started = store.append({
		kind: "reflection.started",
		sessionId,
		streamId,
		eventTime: now,
		actor: "system",
		subjectId: "akasha",
		sourceKey: `reflection:${sessionId}:${now}:started`,
		parentEventIds,
		payload: {
			eventCount: events.length,
			limit: options.limit ?? 500,
		},
		importance: 0.55,
		ttlPolicy: "long_term",
	});

	const crystalDrafts = createCrystalDrafts(events, sessionId, streamId);
	const crystals = crystalDrafts.map((draft) =>
		store.append({
			...draft,
			parentEventIds: [...(draft.parentEventIds ?? []), started.eventId],
		}),
	);
	const memoryCrystals = crystals.map((crystal) => store.append(toMemoryCrystalDraft(crystal)));

	const completed = store.append({
		kind: "reflection.completed",
		sessionId,
		streamId,
		eventTime: now,
		actor: "system",
		subjectId: "akasha",
		sourceKey: `reflection:${sessionId}:${now}:completed`,
		parentEventIds: [started.eventId, ...crystals.map((event) => event.eventId)],
		payload: {
			crystalCount: crystals.length,
			memoryCrystalCount: memoryCrystals.length,
		},
		importance: 0.6,
		ttlPolicy: "long_term",
	});

	return { started, crystals, memoryCrystals, completed };
}
