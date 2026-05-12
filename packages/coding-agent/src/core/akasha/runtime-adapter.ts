import type { AkashaActor, AkashaEventDraft, AkashaEventKind } from "./types.js";

export interface AkashaRuntimeEvent {
	type: string;
	sessionId: string;
	streamId?: string;
	eventTime?: string;
	actor?: AkashaActor;
	subjectId?: string;
	objectId?: string;
	toolCallId?: string;
	sourceKey?: string;
	parentEventIds?: string[];
	correlationId?: string;
	payload?: Record<string, unknown>;
	importance?: number;
}

export interface AkashaRuntimeAdapter {
	readonly name: string;
	map(event: AkashaRuntimeEvent): AkashaEventDraft | undefined;
}

export interface AkashaGenericRuntimeAdapterOptions {
	name?: string;
	kindMap?: Record<string, AkashaEventKind>;
	defaultActor?: AkashaActor;
}

export function createGenericRuntimeAdapter(options: AkashaGenericRuntimeAdapterOptions = {}): AkashaRuntimeAdapter {
	const name = options.name ?? "generic";
	const defaultActor = options.defaultActor ?? "system";
	return {
		name,
		map(event) {
			const kind = options.kindMap?.[event.type] ?? safeKind(event.type);
			if (!kind) return undefined;
			return {
				kind,
				sessionId: event.sessionId,
				streamId: event.streamId ?? `session:${event.sessionId}`,
				eventTime: event.eventTime ?? new Date().toISOString(),
				actor: event.actor ?? defaultActor,
				subjectId: event.subjectId,
				objectId: event.objectId,
				toolCallId: event.toolCallId,
				sourceKey: event.sourceKey ?? deterministicSourceKey(name, event),
				parentEventIds: event.parentEventIds ?? [],
				correlationId: event.correlationId,
				payload: {
					runtime: name,
					runtimeType: event.type,
					...(event.payload ?? {}),
				},
				importance: event.importance ?? 0.5,
				ttlPolicy: "session",
			};
		},
	};
}

function safeKind(type: string): AkashaEventKind | undefined {
	if (KNOWN_KINDS.has(type as AkashaEventKind)) return type as AkashaEventKind;
	return undefined;
}

function deterministicSourceKey(name: string, event: AkashaRuntimeEvent): string | undefined {
	if (!event.eventTime) return undefined;
	return [name, event.sessionId, event.type, event.eventTime, event.toolCallId ?? "", event.objectId ?? ""].join(":");
}

const KNOWN_KINDS = new Set<AkashaEventKind>([
	"session.started",
	"session.resumed",
	"session.forked",
	"session.reloaded",
	"session.shutdown",
	"turn.started",
	"turn.completed",
	"policy.evaluated",
	"daemon.tick",
	"time.callback.scheduled",
	"time.callback.due",
	"time.callback.completed",
	"message.user.submitted",
	"message.agent.completed",
	"message.tool_result.recorded",
	"message.custom.recorded",
	"tool.requested",
	"tool.blocked",
	"tool.completed",
	"artifact.read",
	"artifact.written",
	"artifact.patched",
	"command.executed",
	"context.compacted",
	"branch.summary_created",
	"model.changed",
	"thinking_level.changed",
	"loop.opened",
	"loop.progressed",
	"loop.blocked",
	"loop.resolved",
	"promise.created",
	"promise.updated",
	"promise.resolved",
	"prediction.made",
	"prediction.checked",
	"prediction.corrected",
	"reflection.started",
	"reflection.completed",
	"memory.pinned",
	"memory.unpinned",
	"memory.suppressed",
	"memory.crystal.created",
	"memory.crystal.updated",
	"pattern.detected",
	"preference.inferred",
	"failure.lesson_learned",
	"workflow.optimized",
	"event.redacted",
]);
