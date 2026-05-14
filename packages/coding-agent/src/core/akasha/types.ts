export type AkashaEventKind =
	| "session.started"
	| "session.resumed"
	| "session.forked"
	| "session.reloaded"
	| "session.shutdown"
	| "turn.started"
	| "turn.completed"
	| "action_gate.injected"
	| "action_surface.requested"
	| "action_surface.completed"
	| "action_surface.failed"
	| "policy.evaluated"
	| "daemon.tick"
	| "time.callback.scheduled"
	| "time.callback.due"
	| "time.callback.claimed"
	| "time.callback.dispatched"
	| "time.callback.completed"
	| "time.callback.failed"
	| "time.callback.cancelled"
	| "callback.inbox.added"
	| "callback.inbox.injected"
	| "callback.inbox.consumed"
	| "callback.inbox.failed"
	| "callback.inbox.cancelled"
	| "time_syscall.audit"
	| "time_syscall.missing"
	| "time_syscall.repaired"
	| "time_syscall.repair_prompt.injected"
	| "message.user.submitted"
	| "message.agent.completed"
	| "message.tool_result.recorded"
	| "message.custom.recorded"
	| "tool.requested"
	| "tool.blocked"
	| "tool.completed"
	| "artifact.read"
	| "artifact.written"
	| "artifact.patched"
	| "command.executed"
	| "context.compacted"
	| "branch.summary_created"
	| "model.changed"
	| "thinking_level.changed"
	| "loop.opened"
	| "loop.progressed"
	| "loop.blocked"
	| "loop.resolved"
	| "promise.created"
	| "promise.updated"
	| "promise.resolved"
	| "prediction.made"
	| "prediction.checked"
	| "prediction.corrected"
	| "reflection.started"
	| "reflection.completed"
	| "memory.pinned"
	| "memory.unpinned"
	| "memory.suppressed"
	| "memory.crystal.created"
	| "memory.crystal.updated"
	| "memory.recalled"
	| "memory.applied"
	| "memory.reinforced"
	| "memory.weakened"
	| "memory.reconsolidated"
	| "memory.decayed"
	| "pattern.detected"
	| "preference.inferred"
	| "failure.lesson_learned"
	| "workflow.optimized"
	| "sleep.replay.started"
	| "sleep.replay.completed"
	| "skill.procedure.created"
	| "skill.procedure.updated"
	| "skill.procedure.applied"
	| "skill.procedure.failed"
	| "skill.procedure.reinforced"
	| "state.observed"
	| "state.confirmed"
	| "state.resolved"
	| "state.superseded"
	| "state.stale"
	| "state.expired"
	| "gateway.started"
	| "gateway.stopped"
	| "gateway.presence.updated"
	| "gateway.update.received"
	| "gateway.message.accepted"
	| "gateway.message.rejected"
	| "gateway.message.queued"
	| "gateway.message.running"
	| "gateway.message.dead_letter"
	| "gateway.outbox.queued"
	| "gateway.outbox.sent"
	| "gateway.outbox.dead_letter"
	| "gateway.reply.sent"
	| "gateway.delivery.failed"
	| "gateway.command.executed"
	| "gateway.callback.delivered"
	| "event.redacted";

export type AkashaActor = "user" | "agent" | "tool" | "system";

export type AkashaTtlPolicy = "ephemeral" | "session" | "short_term" | "long_term" | "permanent";

export interface AkashaEvent {
	eventId: string;
	kind: AkashaEventKind;
	sessionId: string;
	streamId: string;
	sequence: number;
	eventTime: string;
	recordedTime: string;
	actor: AkashaActor;
	subjectId?: string;
	objectId?: string;
	toolCallId?: string;
	sourceKey?: string;
	parentEventIds: string[];
	correlationId?: string;
	payload: Record<string, unknown>;
	importance: number;
	ttlPolicy: AkashaTtlPolicy;
	version: 1;
}

export type AkashaEventDraft = Omit<
	AkashaEvent,
	"eventId" | "sequence" | "recordedTime" | "version" | "parentEventIds" | "payload" | "importance" | "ttlPolicy"
> & {
	eventId?: string;
	sequence?: number;
	recordedTime?: string;
	version?: 1;
	parentEventIds?: string[];
	payload?: Record<string, unknown>;
	importance?: number;
	ttlPolicy?: AkashaTtlPolicy;
};

export interface AkashaQuery {
	limit?: number;
	kinds?: AkashaEventKind[];
	text?: string;
	since?: string;
	until?: string;
	toolCallId?: string;
}

export interface AkashaTemporalBrief {
	text: string;
	events: AkashaEvent[];
}

export interface AkashaStore {
	readonly eventLogPath: string;
	append(event: AkashaEventDraft): AkashaEvent;
	listRecent(query?: AkashaQuery): AkashaEvent[];
	findById(eventId: string): AkashaEvent | undefined;
	findByToolCallId(toolCallId: string): AkashaEvent | undefined;
	explainChain(eventIdOrToolCallId: string): AkashaEvent[];
	buildTimeline(query?: AkashaQuery): AkashaEvent[];
}
