import { buildAkashaTemporalStateLedger } from "./temporal-state-ledger.js";
import {
	type AkashaTemporalStateClass,
	computeAkashaExpiresAt,
	computeAkashaValidUntil,
	createAkashaTemporalStateId,
	isAkashaEphemeralStateClass,
	normalizeAkashaTemporalStateKey,
} from "./temporal-validity.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export interface AkashaDetectedEphemeralState {
	stateClass: AkashaTemporalStateClass;
	stateKey: string;
	summary: string;
	confidence: number;
	currentnessRequired: boolean;
	safetyKind?: "health";
}

const HEALTH_PATTERNS: Array<{ key: string; summary: string; patterns: RegExp[] }> = [
	{
		key: "abdominal_pain",
		summary: "用户说肚子疼",
		patterns: [/肚子疼/u, /肚子痛/u, /腹痛/u, /\bstomach (hurts|ache|pain)\b/i, /\babdominal pain\b/i],
	},
	{
		key: "headache",
		summary: "用户说头疼",
		patterns: [/头疼/u, /头痛/u, /\bheadache\b/i, /\bhead hurts\b/i],
	},
	{
		key: "fever",
		summary: "用户说发烧",
		patterns: [/发烧/u, /发热/u, /\bfever\b/i],
	},
	{
		key: "unwell",
		summary: "用户说身体不舒服",
		patterns: [/不舒服/u, /身体不适/u, /\bfeel sick\b/i, /\bunwell\b/i],
	},
];

const MOOD_PATTERNS: Array<{ key: string; summary: string; patterns: RegExp[] }> = [
	{ key: "tired", summary: "用户说很累", patterns: [/很累/u, /好累/u, /\btired\b/i, /\bexhausted\b/i] },
	{
		key: "anxious",
		summary: "用户说焦虑",
		patterns: [/焦虑/u, /紧张/u, /\banxious\b/i, /\bstressed\b/i],
	},
	{
		key: "bad_mood",
		summary: "用户说心情不好",
		patterns: [/心情不好/u, /难过/u, /\bbad mood\b/i, /\bupset\b/i],
	},
];

const LOCATION_PATTERNS: Array<{ key: string; summary: string; patterns: RegExp[] }> = [
	{ key: "outside", summary: "用户说在外面", patterns: [/在外面/u, /出门/u, /\boutside\b/i] },
	{ key: "home", summary: "用户说在家", patterns: [/在家/u, /到家/u, /\bat home\b/i] },
	{ key: "office", summary: "用户说在公司", patterns: [/在公司/u, /在办公室/u, /\bat (work|office)\b/i] },
];

const AVAILABILITY_PATTERNS: Array<{ key: string; summary: string; patterns: RegExp[] }> = [
	{ key: "available_today", summary: "用户说今天有空", patterns: [/今天有空/u, /\bfree today\b/i] },
	{ key: "busy_now", summary: "用户说现在没时间", patterns: [/现在没时间/u, /现在很忙/u, /\bbusy now\b/i] },
	{ key: "later", summary: "用户说一会儿再说", patterns: [/一会儿再说/u, /晚点再说/u, /\blater\b/i] },
];

const RESOLVED_PATTERNS = [
	/已经好了/u,
	/好多了/u,
	/没事了/u,
	/不疼了/u,
	/不痛了/u,
	/解决了/u,
	/\bnot anymore\b/i,
	/\bfine now\b/i,
	/\bit'?s fine now\b/i,
	/\bresolved\b/i,
];

export function detectAkashaEphemeralStates(text: string): AkashaDetectedEphemeralState[] {
	const detections: AkashaDetectedEphemeralState[] = [];
	for (const item of HEALTH_PATTERNS) {
		if (matchesAny(text, item.patterns) && !looksLikeResolvedHealth(text)) {
			detections.push({
				stateClass: "health_state",
				stateKey: item.key,
				summary: item.summary,
				confidence: 0.82,
				currentnessRequired: true,
				safetyKind: "health",
			});
		}
	}
	for (const item of MOOD_PATTERNS) {
		if (matchesAny(text, item.patterns)) {
			detections.push({
				stateClass: "mood_state",
				stateKey: item.key,
				summary: item.summary,
				confidence: 0.72,
				currentnessRequired: true,
			});
		}
	}
	for (const item of LOCATION_PATTERNS) {
		if (matchesAny(text, item.patterns)) {
			detections.push({
				stateClass: "location_state",
				stateKey: item.key,
				summary: item.summary,
				confidence: 0.7,
				currentnessRequired: true,
			});
		}
	}
	for (const item of AVAILABILITY_PATTERNS) {
		if (matchesAny(text, item.patterns)) {
			detections.push({
				stateClass: "availability_state",
				stateKey: item.key,
				summary: item.summary,
				confidence: 0.68,
				currentnessRequired: true,
			});
		}
	}
	return dedupeDetections(detections);
}

export function deriveAkashaEphemeralStateEventsFromUserMessage(
	userEvent: AkashaEvent,
	timeline: AkashaEvent[],
): AkashaEventDraft[] {
	if (userEvent.kind !== "message.user.submitted") return [];
	const text = typeof userEvent.payload.text === "string" ? userEvent.payload.text : "";
	if (!text.trim()) return [];
	const drafts: AkashaEventDraft[] = [];
	const prior = timeline.filter((event) => event.eventId !== userEvent.eventId);
	const priorLedger = buildAkashaTemporalStateLedger(prior, { now: userEvent.eventTime });
	if (looksLikeResolvedState(text)) {
		const target = [...priorLedger.current, ...priorLedger.stale, ...priorLedger.expired]
			.filter((state) => isAkashaEphemeralStateClass(state.stateClass))
			.sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];
		if (target) {
			drafts.push({
				kind: "state.resolved",
				sessionId: userEvent.sessionId,
				streamId: userEvent.streamId,
				eventTime: userEvent.eventTime,
				actor: "system",
				subjectId: "akasha.temporal_validity",
				objectId: target.stateId,
				sourceKey: `temporal-state:${userEvent.eventId}:resolved:${target.stateId}`,
				parentEventIds: [userEvent.eventId, target.latestEventId],
				correlationId: userEvent.correlationId,
				payload: {
					stateId: target.stateId,
					stateClass: target.stateClass,
					stateKey: target.stateKey,
					summary: target.summary,
					resolution: "user_reported_resolved",
					sourceEventIds: [userEvent.eventId, target.latestEventId],
				},
				importance: 0.78,
				ttlPolicy: "short_term",
			});
		}
	}

	for (const detection of detectAkashaEphemeralStates(text)) {
		const stateKey = normalizeAkashaTemporalStateKey(detection.stateKey);
		const stateId = createAkashaTemporalStateId(detection.stateClass, stateKey);
		const existing = priorLedger.states.find(
			(state) =>
				state.stateId === stateId &&
				state.status !== "resolved" &&
				state.status !== "superseded" &&
				state.status !== "expired",
		);
		const kind = existing ? "state.confirmed" : "state.observed";
		const validFrom = userEvent.eventTime;
		drafts.push({
			kind,
			sessionId: userEvent.sessionId,
			streamId: userEvent.streamId,
			eventTime: userEvent.eventTime,
			actor: "system",
			subjectId: "akasha.temporal_validity",
			objectId: stateId,
			sourceKey: `temporal-state:${userEvent.eventId}:${kind}:${stateId}`,
			parentEventIds: existing ? [userEvent.eventId, existing.latestEventId] : [userEvent.eventId],
			correlationId: userEvent.correlationId,
			payload: {
				stateId,
				stateClass: detection.stateClass,
				stateKey,
				summary: detection.summary,
				validFrom,
				validUntil: computeAkashaValidUntil(detection.stateClass, validFrom),
				expiresAt: computeAkashaExpiresAt(detection.stateClass, validFrom),
				currentnessRequired: detection.currentnessRequired,
				confidence: detection.confidence,
				safetyKind: detection.safetyKind,
				sourceEventIds: [userEvent.eventId],
			},
			importance: detection.stateClass === "health_state" ? 0.86 : 0.72,
			ttlPolicy: "short_term",
		});
	}
	return drafts;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

function looksLikeResolvedState(text: string): boolean {
	return matchesAny(text, RESOLVED_PATTERNS);
}

function looksLikeResolvedHealth(text: string): boolean {
	return /不疼了|不痛了|已经好了|好多了/u.test(text) || /\bnot anymore\b/i.test(text);
}

function dedupeDetections(detections: AkashaDetectedEphemeralState[]): AkashaDetectedEphemeralState[] {
	const seen = new Set<string>();
	const result: AkashaDetectedEphemeralState[] = [];
	for (const detection of detections) {
		const key = `${detection.stateClass}:${detection.stateKey}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(detection);
	}
	return result;
}
