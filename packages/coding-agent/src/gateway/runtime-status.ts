import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AkashaGatewayMode } from "./types.js";

export type AkashaGatewayRuntimeState = "starting" | "running" | "stopping" | "stopped" | "error";
export type AkashaGatewayPlatformRuntimeState = "starting" | "polling" | "webhook" | "stopped" | "error";

export interface AkashaGatewayRuntimeStatus {
	pid: number;
	startedAt: string;
	updatedAt: string;
	gatewayState: AkashaGatewayRuntimeState;
	platformState: AkashaGatewayPlatformRuntimeState;
	mode: AkashaGatewayMode;
	activeChats: string[];
	pendingInbox: number;
	pendingOutbox: number;
	deadLetters: number;
	lastUpdateId?: number;
	lastError?: string;
}

export function resolveAkashaGatewayRuntimeStatusPath(agentDir: string): string {
	return join(agentDir, "gateway", "runtime-status.json");
}

export function writeAkashaGatewayRuntimeStatus(agentDir: string, status: AkashaGatewayRuntimeStatus): void {
	const path = resolveAkashaGatewayRuntimeStatusPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, JSON.stringify(status, null, 2), "utf-8");
	renameSync(tempPath, path);
}

export function readAkashaGatewayRuntimeStatus(agentDir: string): AkashaGatewayRuntimeStatus | undefined {
	const path = resolveAkashaGatewayRuntimeStatusPath(agentDir);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return isRuntimeStatus(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function akashaGatewayRuntimeStatusAgeMs(status: AkashaGatewayRuntimeStatus, now = new Date()): number {
	return Math.max(0, now.getTime() - Date.parse(status.updatedAt));
}

function isRuntimeStatus(value: unknown): value is AkashaGatewayRuntimeStatus {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.pid === "number" &&
		typeof record.startedAt === "string" &&
		typeof record.updatedAt === "string" &&
		isGatewayState(record.gatewayState) &&
		isPlatformState(record.platformState) &&
		(record.mode === "polling" || record.mode === "webhook") &&
		Array.isArray(record.activeChats) &&
		record.activeChats.every((chat) => typeof chat === "string") &&
		typeof record.pendingInbox === "number" &&
		typeof record.pendingOutbox === "number" &&
		typeof record.deadLetters === "number"
	);
}

function isGatewayState(value: unknown): value is AkashaGatewayRuntimeState {
	return (
		value === "starting" || value === "running" || value === "stopping" || value === "stopped" || value === "error"
	);
}

function isPlatformState(value: unknown): value is AkashaGatewayPlatformRuntimeState {
	return (
		value === "starting" || value === "polling" || value === "webhook" || value === "stopped" || value === "error"
	);
}
