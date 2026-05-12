import type { AkashaActor, AkashaEvent, AkashaEventKind, AkashaTtlPolicy } from "./types.js";

export const CURRENT_AKASHA_EVENT_VERSION = 1 as const;

export const KNOWN_AKASHA_EVENT_KINDS = new Set<AkashaEventKind>([
	"session.started",
	"session.resumed",
	"session.forked",
	"session.reloaded",
	"session.shutdown",
	"turn.started",
	"turn.completed",
	"action_gate.injected",
	"policy.evaluated",
	"daemon.tick",
	"time.callback.scheduled",
	"time.callback.due",
	"time.callback.claimed",
	"time.callback.dispatched",
	"time.callback.completed",
	"time.callback.failed",
	"time.callback.cancelled",
	"time_syscall.audit",
	"time_syscall.missing",
	"time_syscall.repaired",
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
	"gateway.started",
	"gateway.stopped",
	"gateway.update.received",
	"gateway.message.accepted",
	"gateway.message.rejected",
	"gateway.reply.sent",
	"gateway.delivery.failed",
	"gateway.command.executed",
	"gateway.callback.delivered",
	"event.redacted",
]);

const KNOWN_AKASHA_ACTORS = new Set<AkashaActor>(["user", "agent", "tool", "system"]);
const KNOWN_POLICY_ACTIONS = new Set(["allow", "block", "require_confirmation", "require_validation", "defer"]);

export interface AkashaSchemaIssue {
	line?: number;
	eventId?: string;
	code: "invalid_json" | "invalid_shape" | "unsupported_version";
	message: string;
}

export interface AkashaSchemaParseResult {
	events: AkashaEvent[];
	issues: AkashaSchemaIssue[];
}

export function parseAkashaJsonl(content: string): AkashaSchemaParseResult {
	const events: AkashaEvent[] = [];
	const issues: AkashaSchemaIssue[] = [];
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line?.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			const migrated = migrateAkashaEvent(parsed);
			if (migrated) {
				events.push(migrated);
			} else {
				issues.push({
					line: index + 1,
					code: "invalid_shape",
					message: "Line does not contain a valid Akasha event",
				});
			}
		} catch (error) {
			issues.push({
				line: index + 1,
				code: "invalid_json",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { events, issues };
}

export function migrateAkashaEvent(value: unknown): AkashaEvent | undefined {
	if (!isRecord(value)) return undefined;
	if (value.version !== undefined && value.version !== CURRENT_AKASHA_EVENT_VERSION) {
		return undefined;
	}
	if (
		typeof value.eventId !== "string" ||
		typeof value.kind !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.streamId !== "string" ||
		typeof value.sequence !== "number" ||
		typeof value.eventTime !== "string" ||
		typeof value.recordedTime !== "string" ||
		typeof value.actor !== "string" ||
		!Array.isArray(value.parentEventIds)
	) {
		return undefined;
	}

	const payload = isRecord(value.payload) ? value.payload : {};
	return {
		eventId: value.eventId,
		kind: value.kind as AkashaEventKind,
		sessionId: value.sessionId,
		streamId: value.streamId,
		sequence: value.sequence,
		eventTime: value.eventTime,
		recordedTime: value.recordedTime,
		actor: value.actor as AkashaActor,
		subjectId: typeof value.subjectId === "string" ? value.subjectId : undefined,
		objectId: typeof value.objectId === "string" ? value.objectId : undefined,
		toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
		sourceKey: typeof value.sourceKey === "string" ? value.sourceKey : undefined,
		parentEventIds: value.parentEventIds.filter((item): item is string => typeof item === "string"),
		correlationId: typeof value.correlationId === "string" ? value.correlationId : undefined,
		payload,
		importance: typeof value.importance === "number" ? value.importance : 0.5,
		ttlPolicy: isTtlPolicy(value.ttlPolicy) ? value.ttlPolicy : "session",
		version: CURRENT_AKASHA_EVENT_VERSION,
	};
}

export function validateAkashaEvent(value: unknown): value is AkashaEvent {
	return migrateAkashaEvent(value) !== undefined;
}

export function validateAkashaEventStrict(event: AkashaEvent): AkashaSchemaIssue[] {
	const issues: AkashaSchemaIssue[] = [];
	if (!KNOWN_AKASHA_EVENT_KINDS.has(event.kind)) {
		issues.push(issue(event.eventId, "invalid_shape", `Unknown Akasha event kind: ${event.kind}`));
	}
	if (!KNOWN_AKASHA_ACTORS.has(event.actor)) {
		issues.push(issue(event.eventId, "invalid_shape", `Unknown Akasha actor: ${event.actor}`));
	}
	if (!isTtlPolicy(event.ttlPolicy)) {
		issues.push(issue(event.eventId, "invalid_shape", `Unknown Akasha TTL policy: ${event.ttlPolicy}`));
	}
	if (!Number.isInteger(event.sequence) || event.sequence <= 0) {
		issues.push(issue(event.eventId, "invalid_shape", "Akasha event sequence must be a positive integer"));
	}
	if (!isIsoDateString(event.eventTime)) {
		issues.push(issue(event.eventId, "invalid_shape", "Akasha eventTime must be parseable"));
	}
	if (!isIsoDateString(event.recordedTime)) {
		issues.push(issue(event.eventId, "invalid_shape", "Akasha recordedTime must be parseable"));
	}
	if (!Number.isFinite(event.importance) || event.importance < 0 || event.importance > 1) {
		issues.push(issue(event.eventId, "invalid_shape", "Akasha importance must be between 0 and 1"));
	}
	if (!Array.isArray(event.parentEventIds) || event.parentEventIds.some((id) => typeof id !== "string")) {
		issues.push(issue(event.eventId, "invalid_shape", "Akasha parentEventIds must be strings"));
	}
	validatePayloadShape(event, issues);
	return issues;
}

export function assertAkashaEventStrict(event: AkashaEvent): void {
	const issues = validateAkashaEventStrict(event);
	if (issues.length === 0) return;
	throw new Error(`Invalid Akasha event ${event.eventId}: ${issues.map((item) => item.message).join("; ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTtlPolicy(value: unknown): value is AkashaTtlPolicy {
	return (
		value === "ephemeral" ||
		value === "session" ||
		value === "short_term" ||
		value === "long_term" ||
		value === "permanent"
	);
}

function isIsoDateString(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

function issue(eventId: string | undefined, code: AkashaSchemaIssue["code"], message: string): AkashaSchemaIssue {
	return { eventId, code, message };
}

function validatePayloadShape(event: AkashaEvent, issues: AkashaSchemaIssue[]): void {
	if (!isRecord(event.payload)) {
		issues.push(issue(event.eventId, "invalid_shape", "Akasha payload must be an object"));
		return;
	}
	if (
		(event.kind === "time.callback.scheduled" ||
			event.kind === "time.callback.due" ||
			event.kind === "time.callback.claimed" ||
			event.kind === "time.callback.dispatched" ||
			event.kind === "time.callback.completed" ||
			event.kind === "time.callback.failed" ||
			event.kind === "time.callback.cancelled") &&
		typeof event.payload.callbackId !== "string"
	) {
		issues.push(issue(event.eventId, "invalid_shape", `${event.kind} requires payload.callbackId`));
	}
	if (event.kind === "policy.evaluated") {
		const action = event.payload.action ?? event.payload.decision;
		if (typeof action !== "string" || !KNOWN_POLICY_ACTIONS.has(action)) {
			issues.push(issue(event.eventId, "invalid_shape", "policy.evaluated requires a valid action"));
		}
	}
	if (event.kind === "promise.created") {
		if (typeof event.payload.promiseId !== "string") {
			issues.push(issue(event.eventId, "invalid_shape", "promise.created requires payload.promiseId"));
		}
		if (typeof event.payload.summary !== "string") {
			issues.push(issue(event.eventId, "invalid_shape", "promise.created requires payload.summary"));
		}
	}
	if (event.kind === "prediction.made") {
		if (typeof event.payload.predictionId !== "string") {
			issues.push(issue(event.eventId, "invalid_shape", "prediction.made requires payload.predictionId"));
		}
		if (typeof event.payload.claim !== "string") {
			issues.push(issue(event.eventId, "invalid_shape", "prediction.made requires payload.claim"));
		}
	}
}
