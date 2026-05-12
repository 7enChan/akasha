import type { ResolvedAkashaReflectionSettings } from "../settings-manager.js";
import { indexAkashaEmbeddings } from "./embedding-indexer.js";
import type { AkashaEmbeddingProvider } from "./embedding-provider.js";
import type { AkashaEmbeddingStore } from "./embedding-store.js";
import { projectAkashaGovernedEvents } from "./governance-projection.js";
import { deriveOpenLoopEvents } from "./open-loops.js";
import { decideReflection } from "./reflection-policy.js";
import type { AkashaReflectionPassResult } from "./reflection-worker.js";
import { runReflectionPass } from "./reflection-worker.js";
import { runAkashaSchedulerPass } from "./scheduler.js";
import type { AkashaEvent, AkashaStore } from "./types.js";

export interface AkashaMaintenanceOptions {
	sessionId: string;
	streamId: string;
	reflection: ResolvedAkashaReflectionSettings;
	embeddingStore?: AkashaEmbeddingStore;
	embeddingProvider?: AkashaEmbeddingProvider;
	now?: Date;
	limit?: number;
}

export interface AkashaMaintenanceResult {
	openLoopEvents: AkashaEvent[];
	schedulerEvents: AkashaEvent[];
	embeddingIndexed: number;
	reflection?: AkashaReflectionPassResult;
	reflectionReason: string;
}

export async function runAkashaMaintenancePass(
	store: AkashaStore,
	options: AkashaMaintenanceOptions,
): Promise<AkashaMaintenanceResult> {
	const now = options.now ?? new Date();
	const timeline = store.buildTimeline({ limit: options.limit ?? 1000 });
	const openLoopEvents = deriveOpenLoopEvents(timeline, options.sessionId, options.streamId).map((draft) =>
		store.append(draft),
	);
	const scheduler = runAkashaSchedulerPass(store, { now, limit: options.limit ?? 1000 });

	let embeddingIndexed = 0;
	if (options.embeddingStore && options.embeddingProvider) {
		const governed = projectAkashaGovernedEvents(store.buildTimeline({ limit: options.limit ?? 1000 }));
		const tombstoneIds = [
			...governed.suppressedEventIds,
			...governed.omittedDerivedEventIds,
			...governed.redactedSourceEventIds,
		];
		if (options.embeddingStore.tombstone) {
			for (const eventId of tombstoneIds) {
				await options.embeddingStore.tombstone(eventId, "governance_projection");
			}
		}
		const indexed = await indexAkashaEmbeddings(
			governed.events.filter((event) => !governed.redactedSourceEventIds.includes(event.eventId)),
			options.embeddingStore,
			options.embeddingProvider,
		);
		if (options.embeddingStore.compact && tombstoneIds.length > 0) {
			await options.embeddingStore.compact();
		}
		embeddingIndexed = indexed.indexed;
	}

	const afterMaintenance = store.buildTimeline({ limit: options.limit ?? 1000 });
	const reflectionDecision = decideReflection(afterMaintenance, options.reflection, now);
	const reflection = reflectionDecision.shouldRun
		? runReflectionPass(store, {
				sessionId: options.sessionId,
				streamId: options.streamId,
				limit: options.limit ?? 1000,
				now: () => now.toISOString(),
			})
		: undefined;

	return {
		openLoopEvents,
		schedulerEvents: scheduler.appended,
		embeddingIndexed,
		reflection,
		reflectionReason: reflectionDecision.reason,
	};
}
