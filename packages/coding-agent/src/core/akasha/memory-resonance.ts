import type { AkashaMemoryCue } from "./memory-cue.js";
import type { AkashaMemoryTrace } from "./memory-trace.js";

export interface AkashaMemoryTraceScore {
	trace: AkashaMemoryTrace;
	score: number;
	reasons: string[];
}

export interface AkashaMemoryResonanceOptions {
	maxResults?: number;
	now?: Date;
}

export function rankAkashaMemoryTraces(
	traces: AkashaMemoryTrace[],
	cue: AkashaMemoryCue,
	options: AkashaMemoryResonanceOptions = {},
): AkashaMemoryTraceScore[] {
	return traces
		.map((trace) => scoreAkashaMemoryTrace(trace, cue, options))
		.filter((score) => score.score > 0)
		.sort((a, b) => b.score - a.score || b.trace.createdAt.localeCompare(a.trace.createdAt))
		.slice(0, options.maxResults ?? 24);
}

export function scoreAkashaMemoryTrace(
	trace: AkashaMemoryTrace,
	cue: AkashaMemoryCue,
	options: AkashaMemoryResonanceOptions = {},
): AkashaMemoryTraceScore {
	const reasons: string[] = [];
	let score = trace.weight * 0.45 + trace.confidence * 0.25;
	const textNeedles = tokenize([cue.userText, cue.currentGoal].filter(Boolean).join(" "));
	const traceText = `${trace.key} ${trace.text}`.toLowerCase();
	const textOverlap = overlapRatio(textNeedles, tokenize(traceText));
	if (textOverlap > 0) {
		score += textOverlap * 1.1;
		reasons.push(`text_overlap:${textOverlap.toFixed(2)}`);
	}

	for (const file of cue.activeFiles) {
		if (file && (trace.key.includes(file) || trace.text.includes(file) || fileBasenameMatches(file, traceText))) {
			score += 1.2;
			reasons.push(`artifact:${file}`);
			break;
		}
	}

	if (cue.activeCallbackIds.includes(trace.key) || cue.activeCallbackIds.some((id) => trace.text.includes(id))) {
		score += 1.1;
		reasons.push("callback_match");
	}

	if (
		cue.pendingInboxItemIds.some((id) => trace.text.includes(id) || trace.key.includes(id)) ||
		trace.sourceEventIds.some((id) => cue.pendingInboxItemIds.includes(id))
	) {
		score += 1.0;
		reasons.push("pending_inbox_match");
	}

	if (trace.sourceEventIds.some((id) => cue.recentFailureEventIds.includes(id))) {
		score += 1.0;
		reasons.push("recent_failure_source");
	}

	if (trace.kind === "failure" && cue.recentFailureEventIds.length > 0) {
		score += 0.7;
		reasons.push("failure_pressure");
	}

	if (trace.kind === "policy" && cue.policyPressure.some((pressure) => trace.key.includes(pressure))) {
		score += 0.8;
		reasons.push("policy_pressure");
	}

	if (trace.sourceEventIds.some((id) => cue.userPreferenceEventIds.includes(id))) {
		score += 0.55;
		reasons.push("user_preference_source");
	}

	if (trace.sourceEventIds.some((id) => cue.strictRepairMissingEventIds.includes(id))) {
		score += 0.9;
		reasons.push("strict_repair_source");
	}

	if (typeof trace.surprise === "number") score += trace.surprise * 0.25;
	if (typeof trace.cost === "number") score += trace.cost * 0.2;
	if (typeof trace.reward === "number") score += trace.reward * 0.12;
	score += recencyBonus(trace.createdAt, options.now ?? new Date());

	if (trace.kind === "time" || trace.kind === "actor") score *= 0.35;
	return {
		trace,
		score: Number(score.toFixed(4)),
		reasons: reasons.length > 0 ? reasons : ["baseline_weight"],
	};
}

function recencyBonus(iso: string, now: Date): number {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return 0;
	const ageDays = Math.max(0, (now.getTime() - then) / 86_400_000);
	if (ageDays <= 1) return 0.25;
	if (ageDays <= 7) return 0.18;
	if (ageDays <= 30) return 0.1;
	return 0.03;
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_\-./\u4e00-\u9fff]+/u)
			.map((part) => part.trim())
			.filter((part) => part.length >= 2),
	);
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let matches = 0;
	for (const token of a) if (b.has(token)) matches++;
	return matches / Math.max(1, a.size);
}

function fileBasenameMatches(file: string, text: string): boolean {
	const base = file.split("/").pop();
	if (!base || base.length < 3) return false;
	const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
	return text.includes(base.toLowerCase()) || (stem.length >= 3 && text.includes(stem.toLowerCase()));
}
