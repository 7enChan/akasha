import type { AkashaSettings } from "../settings-manager.js";

export function createAkashaDogfoodPreset(): AkashaSettings {
	return {
		enabled: true,
		injectTemporalBrief: true,
		maxBriefEvents: 12,
		actionGate: {
			enabled: true,
			includeProjectState: true,
			includeUserTimeline: true,
			maxItems: 8,
			enforceToolGate: true,
			blockDestructiveCommands: true,
			blockUnverifiedArtifactWrites: false,
		},
		embedding: {
			enabled: false,
			provider: "off",
		},
		reflection: {
			enabled: false,
			minEventsSinceLastReflection: 40,
			minIntervalMinutes: 240,
		},
		maintenance: {
			enabled: true,
			runOnTurnEnd: true,
			heartbeatEnabled: true,
			heartbeatIntervalMinutes: 30,
			runOnSessionStart: false,
		},
		privacy: {
			redactSecrets: true,
		},
	};
}

export function mergeAkashaSettings(base: AkashaSettings | undefined, override: AkashaSettings): AkashaSettings {
	return {
		...(base ?? {}),
		...override,
		embedding: {
			...(base?.embedding ?? {}),
			...(override.embedding ?? {}),
		},
		actionGate: {
			...(base?.actionGate ?? {}),
			...(override.actionGate ?? {}),
		},
		reflection: {
			...(base?.reflection ?? {}),
			...(override.reflection ?? {}),
		},
		maintenance: {
			...(base?.maintenance ?? {}),
			...(override.maintenance ?? {}),
		},
		privacy: {
			...(base?.privacy ?? {}),
			...(override.privacy ?? {}),
		},
	};
}
