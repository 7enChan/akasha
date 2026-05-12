import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function resolveAkashaGatewayEnvPath(agentDir: string): string {
	return join(agentDir, ".env");
}

export function loadAkashaGatewayEnv(
	agentDir: string,
	baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
	const envPath = resolveAkashaGatewayEnvPath(agentDir);
	const fileEnv = existsSync(envPath) ? parseDotEnv(readFileSync(envPath, "utf-8")) : {};
	return {
		...fileEnv,
		...baseEnv,
	};
}

export function parseDotEnv(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const equals = line.indexOf("=");
		if (equals <= 0) continue;
		const key = line.slice(0, equals).trim();
		const value = line.slice(equals + 1).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		result[key] = unquoteDotEnvValue(value);
	}
	return result;
}

function unquoteDotEnvValue(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		const inner = value.slice(1, -1);
		return value.startsWith('"') ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
	}
	return value;
}
