import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export interface AkashaRedactionTarget {
	targetEventId: string;
	fields: string[];
	reason: string;
	redactionEventId: string;
}

export function createRedactionEvent(
	target: AkashaEvent,
	fields: string[] = ["payload"],
	reason = "user_requested",
): AkashaEventDraft {
	const normalizedFields = [...new Set(fields)].sort();
	return {
		kind: "event.redacted",
		sessionId: target.sessionId,
		streamId: target.streamId,
		eventTime: new Date().toISOString(),
		actor: "system",
		subjectId: "akasha.redaction",
		objectId: target.eventId,
		sourceKey: `redaction:${target.eventId}:${normalizedFields.join(",")}`,
		parentEventIds: [target.eventId],
		payload: {
			targetEventId: target.eventId,
			fields: normalizedFields,
			reason,
		},
		importance: 0.95,
		ttlPolicy: "permanent",
	};
}

export function collectRedactionTargets(events: AkashaEvent[]): AkashaRedactionTarget[] {
	return events
		.filter((event) => event.kind === "event.redacted")
		.map((event) => {
			const fields = Array.isArray(event.payload.fields)
				? event.payload.fields.filter((field): field is string => typeof field === "string")
				: ["payload"];
			return {
				targetEventId:
					typeof event.payload.targetEventId === "string"
						? event.payload.targetEventId
						: (event.objectId ?? event.parentEventIds[0] ?? ""),
				fields,
				reason: typeof event.payload.reason === "string" ? event.payload.reason : "redacted",
				redactionEventId: event.eventId,
			};
		})
		.filter((target) => target.targetEventId.length > 0);
}

export function applyAkashaRedactions(events: AkashaEvent[]): AkashaEvent[] {
	const targets = collectRedactionTargets(events);
	if (targets.length === 0) return events;
	const byTarget = new Map<string, AkashaRedactionTarget[]>();
	for (const target of targets) {
		byTarget.set(target.targetEventId, [...(byTarget.get(target.targetEventId) ?? []), target]);
	}

	return events.map((event) => {
		const eventTargets = byTarget.get(event.eventId);
		if (!eventTargets) return event;
		const next: AkashaEvent = {
			...event,
			payload: { ...event.payload },
		};
		for (const target of eventTargets) {
			for (const field of target.fields) {
				if (field === "payload") {
					next.payload = { redacted: true, reason: target.reason };
				} else if (field.startsWith("payload.")) {
					const key = field.slice("payload.".length);
					next.payload[key] = "[redacted]";
				} else if (field === "objectId") {
					next.objectId = "[redacted]";
				} else if (field === "subjectId") {
					next.subjectId = "[redacted]";
				}
			}
		}
		return next;
	});
}
