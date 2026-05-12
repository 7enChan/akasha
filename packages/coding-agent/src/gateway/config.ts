import { resolve } from "node:path";
import type { ResolvedAkashaSettings } from "../core/settings-manager.js";
import { loadAkashaGatewayEnv } from "./env.js";
import type { AkashaGatewayConfig, AkashaGatewayConfigStatus } from "./types.js";

export interface ResolveAkashaGatewayConfigOptions {
	agentDir: string;
	cwd: string;
	settings: ResolvedAkashaSettings;
	env?: Record<string, string | undefined>;
}

export function resolveAkashaGatewayConfig(options: ResolveAkashaGatewayConfigOptions): AkashaGatewayConfigStatus {
	const env = options.env ?? loadAkashaGatewayEnv(options.agentDir);
	const gateway = options.settings.gateway;
	const telegramSettings = gateway.platforms.telegram;
	const defaultCwd = resolve(env.AKASHA_GATEWAY_DEFAULT_CWD ?? gateway.defaultCwd ?? options.cwd);
	const botToken = env[telegramSettings.botTokenEnv];
	const allowedUsers = parseNumericSet(env[telegramSettings.allowedUsersEnv]);
	const homeChatId = parseOptionalNumber(env[telegramSettings.homeChatEnv]);
	const webhookUrl = env[telegramSettings.webhookUrlEnv];
	const webhookSecret = env[telegramSettings.webhookSecretEnv];
	const webhookPort = parseOptionalNumber(env[telegramSettings.webhookPortEnv]) ?? 8443;
	const mode = webhookUrl ? "webhook" : telegramSettings.mode;
	const config: AkashaGatewayConfig = {
		enabled: gateway.enabled,
		agentDir: options.agentDir,
		defaultCwd,
		telegram: {
			enabled: telegramSettings.enabled,
			mode,
			botToken,
			allowedUsers,
			homeChatId,
			webhookUrl,
			webhookSecret,
			webhookPort,
		},
	};
	const missing: string[] = [];
	const warnings: string[] = [];
	if (!gateway.enabled) warnings.push("akasha.gateway.enabled is false");
	if (!telegramSettings.enabled) warnings.push("akasha.gateway.platforms.telegram.enabled is false");
	if (!botToken) missing.push(telegramSettings.botTokenEnv);
	if (allowedUsers.size === 0) missing.push(telegramSettings.allowedUsersEnv);
	if (mode === "webhook") {
		if (!webhookUrl) missing.push(telegramSettings.webhookUrlEnv);
		if (!webhookSecret) missing.push(telegramSettings.webhookSecretEnv);
	}
	if (!homeChatId) warnings.push(`${telegramSettings.homeChatEnv} is not set; daemon callbacks will not be delivered`);
	return {
		ok: missing.length === 0 && gateway.enabled && telegramSettings.enabled,
		missing,
		warnings,
		config,
	};
}

export function parseNumericSet(value: string | undefined): Set<number> {
	const result = new Set<number>();
	if (!value) return result;
	for (const part of value.split(",")) {
		const parsed = Number(part.trim());
		if (Number.isSafeInteger(parsed)) result.add(parsed);
	}
	return result;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}
