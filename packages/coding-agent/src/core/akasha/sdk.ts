import { buildKarmaLedger } from "./karma-ledger.js";
import type { AkashaRuntimeAdapter, AkashaRuntimeEvent } from "./runtime-adapter.js";
import type { AkashaEvent, AkashaEventDraft, AkashaQuery, AkashaStore } from "./types.js";
import { buildWorldModel } from "./world-model.js";

export interface AkashaClient {
	record(draft: AkashaEventDraft): AkashaEvent;
	recordRuntime(event: AkashaRuntimeEvent): AkashaEvent | undefined;
	timeline(query?: AkashaQuery): AkashaEvent[];
	explain(eventIdOrToolCallId: string): AkashaEvent[];
	worldModel(): ReturnType<typeof buildWorldModel>;
	karma(): ReturnType<typeof buildKarmaLedger>;
}

export interface AkashaClientOptions {
	store: AkashaStore;
	adapter?: AkashaRuntimeAdapter;
}

export function createAkashaClient(options: AkashaClientOptions): AkashaClient {
	const { store, adapter } = options;
	return {
		record(draft) {
			return store.append(draft);
		},
		recordRuntime(event) {
			const mapped = adapter?.map(event);
			return mapped ? store.append(mapped) : undefined;
		},
		timeline(query) {
			return store.buildTimeline(query);
		},
		explain(eventIdOrToolCallId) {
			return store.explainChain(eventIdOrToolCallId);
		},
		worldModel() {
			return buildWorldModel(store.buildTimeline({ limit: Number.MAX_SAFE_INTEGER }));
		},
		karma() {
			return buildKarmaLedger(store.buildTimeline({ limit: Number.MAX_SAFE_INTEGER }));
		},
	};
}
