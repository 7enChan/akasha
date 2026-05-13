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
		temporalProtocol: {
			syscallAuditMode: "soft",
		},
		holographicMemory: {
			enabled: true,
			injectIntoActionGate: true,
			recordRecallEvents: true,
			maxTraces: 24,
			maxEpisodes: 3,
			maxLessons: 3,
			maxProcedures: 2,
			maxWarnings: 3,
		},
		policyProfile: "dogfood",
		gateway: {
			enabled: false,
			callbackMode: "notify_only",
			platforms: {
				telegram: {
					enabled: false,
					mode: "polling",
				},
			},
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
		temporalProtocol: {
			...(base?.temporalProtocol ?? {}),
			...(override.temporalProtocol ?? {}),
		},
		holographicMemory: {
			...(base?.holographicMemory ?? {}),
			...(override.holographicMemory ?? {}),
		},
		gateway: {
			...(base?.gateway ?? {}),
			...(override.gateway ?? {}),
			platforms: {
				...(base?.gateway?.platforms ?? {}),
				...(override.gateway?.platforms ?? {}),
				telegram: {
					...(base?.gateway?.platforms?.telegram ?? {}),
					...(override.gateway?.platforms?.telegram ?? {}),
				},
			},
		},
	};
}
