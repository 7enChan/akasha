import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";
import type { AkashaValidationScope } from "./validation.js";
import { inferValidationCommand } from "./validation.js";

export type AkashaArtifactStatus = "observed" | "modified_unverified" | "modified_verified" | "failed";

export interface AkashaArtifactState {
	path: string;
	status: AkashaArtifactStatus;
	firstEventId: string;
	lastEventId: string;
	lastKind: AkashaEvent["kind"];
	lastEventTime: string;
	lastSequence: number;
	lastValidationEventId?: string;
	lastValidationObservedEventId?: string;
	lastValidationScope?: AkashaValidationScope;
	lastValidationConfidence?: number;
	lastFailureEventId?: string;
	readCount: number;
	writeCount: number;
	patchCount: number;
}

export function buildArtifactStates(events: AkashaEvent[]): AkashaArtifactState[] {
	const states = new Map<string, AkashaArtifactState>();
	const lastIndexes = new Map<string, number>();
	const ordered = orderAkashaEvents(events);

	for (const [index, event] of ordered.entries()) {
		if (isArtifactEvent(event)) {
			const path = artifactPath(event);
			if (!path) continue;
			const existing = states.get(path);
			const failed = event.payload.isError === true;
			const changed = event.kind === "artifact.written" || event.kind === "artifact.patched";
			const previous = existing ?? initialState(path, event);
			const next: AkashaArtifactState = {
				...previous,
				status: failed ? "failed" : changed ? "modified_unverified" : previous.status,
				lastEventId: event.eventId,
				lastKind: event.kind,
				lastEventTime: event.eventTime,
				lastSequence: event.sequence,
				lastFailureEventId: failed ? event.eventId : previous.lastFailureEventId,
				readCount: previous.readCount + (event.kind === "artifact.read" ? 1 : 0),
				writeCount: previous.writeCount + (event.kind === "artifact.written" ? 1 : 0),
				patchCount: previous.patchCount + (event.kind === "artifact.patched" ? 1 : 0),
			};
			states.set(path, next);
			lastIndexes.set(path, index);
			continue;
		}

		const validation = inferValidationCommand(event, [...states.keys()]);
		if (validation) {
			for (const state of states.values()) {
				if ((lastIndexes.get(state.path) ?? -1) < index && state.status === "modified_unverified") {
					state.lastValidationObservedEventId = event.eventId;
					state.lastValidationScope = validation.scope;
					state.lastValidationConfidence = validation.confidence;
					if (validation.targetPaths.includes(state.path)) {
						state.status = "modified_verified";
						state.lastValidationEventId = event.eventId;
					}
				}
			}
		}
	}

	return [...states.values()].sort(
		(a, b) =>
			b.lastEventTime.localeCompare(a.lastEventTime) ||
			b.lastSequence - a.lastSequence ||
			a.path.localeCompare(b.path),
	);
}

function initialState(path: string, event: AkashaEvent): AkashaArtifactState {
	return {
		path,
		status: "observed",
		firstEventId: event.eventId,
		lastEventId: event.eventId,
		lastKind: event.kind,
		lastEventTime: event.eventTime,
		lastSequence: event.sequence,
		readCount: 0,
		writeCount: 0,
		patchCount: 0,
	};
}

function isArtifactEvent(event: AkashaEvent): boolean {
	return event.kind === "artifact.read" || event.kind === "artifact.written" || event.kind === "artifact.patched";
}

function artifactPath(event: AkashaEvent): string | undefined {
	if (typeof event.payload.path === "string") return event.payload.path;
	return event.objectId;
}
