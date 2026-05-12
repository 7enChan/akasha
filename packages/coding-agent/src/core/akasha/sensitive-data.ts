import type { AkashaEventDraft } from "./types.js";

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
	{ name: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{ name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
	{ name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ name: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g },
	{ name: "api_key_assignment", pattern: /\b(api[_-]?key|token|secret)=([A-Za-z0-9._~+/=-]{16,})\b/gi },
];

export interface AkashaSecretScanResult {
	redacted: boolean;
	secretTypes: string[];
}

export function scanAkashaSecrets(value: unknown): AkashaSecretScanResult {
	const text = collectStrings(value).join("\n");
	const secretTypes = SECRET_PATTERNS.filter(({ pattern }) => {
		pattern.lastIndex = 0;
		return pattern.test(text);
	}).map(({ name }) => name);
	return {
		redacted: secretTypes.length > 0,
		secretTypes,
	};
}

export function sanitizeAkashaEventDraft(draft: AkashaEventDraft): AkashaEventDraft {
	const scan = scanAkashaSecrets(draft);
	if (!scan.redacted) return draft;
	const redactedDraft = redactUnknown(draft) as AkashaEventDraft;
	return {
		...redactedDraft,
		payload: {
			...(redactUnknown(draft.payload ?? {}) as Record<string, unknown>),
			akashaRedactedSecretTypes: scan.secretTypes,
		},
	} as AkashaEventDraft;
}

function redactUnknown(value: unknown): unknown {
	if (typeof value === "string") return redactString(value);
	if (Array.isArray(value)) return value.map(redactUnknown);
	if (typeof value !== "object" || value === null) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = redactUnknown(item);
	}
	return result;
}

function redactString(value: string): string {
	let next = value;
	for (const { name, pattern } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		next = next.replace(pattern, (_match, key: string | undefined) => {
			if (name === "api_key_assignment" && key) {
				return `${key}=[redacted:${name}]`;
			}
			return `[redacted:${name}]`;
		});
	}
	return next;
}

function collectStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(collectStrings);
	if (typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap(collectStrings);
}
