import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AkashaGatewayChatState, AkashaGatewayPlatform } from "./types.js";

interface AkashaGatewayStateFile {
	chats: AkashaGatewayChatState[];
}

export class AkashaGatewaySessionStore {
	private state: AkashaGatewayStateFile;

	constructor(private readonly agentDir: string) {
		this.state = this.read();
	}

	getChat(platform: AkashaGatewayPlatform, chatId: string, defaultCwd: string): AkashaGatewayChatState {
		const existing = this.state.chats.find((chat) => chat.platform === platform && chat.chatId === chatId);
		if (existing) return existing;
		const created: AkashaGatewayChatState = {
			platform,
			chatId,
			cwd: defaultCwd,
			sessionDir: this.resolveChatSessionDir(platform, chatId),
			updatedAt: new Date().toISOString(),
		};
		this.state.chats.push(created);
		this.write();
		return created;
	}

	setCwd(platform: AkashaGatewayPlatform, chatId: string, cwd: string, defaultCwd: string): AkashaGatewayChatState {
		const chat = this.getChat(platform, chatId, defaultCwd);
		chat.cwd = cwd;
		chat.updatedAt = new Date().toISOString();
		this.write();
		return chat;
	}

	setLastUpdateId(platform: AkashaGatewayPlatform, chatId: string, updateId: number, defaultCwd: string): void {
		const chat = this.getChat(platform, chatId, defaultCwd);
		chat.lastUpdateId = updateId;
		chat.updatedAt = new Date().toISOString();
		this.write();
	}

	getLastUpdateId(platform: AkashaGatewayPlatform): number | undefined {
		const ids = this.state.chats
			.filter((chat) => chat.platform === platform && typeof chat.lastUpdateId === "number")
			.map((chat) => chat.lastUpdateId!);
		return ids.length > 0 ? Math.max(...ids) : undefined;
	}

	resetSession(platform: AkashaGatewayPlatform, chatId: string, defaultCwd: string): AkashaGatewayChatState {
		const chat = this.getChat(platform, chatId, defaultCwd);
		chat.sessionDir = this.resolveChatSessionDir(platform, `${chatId}-${Date.now()}`);
		chat.updatedAt = new Date().toISOString();
		this.write();
		return chat;
	}

	listChats(): AkashaGatewayChatState[] {
		return [...this.state.chats];
	}

	private resolveChatSessionDir(platform: AkashaGatewayPlatform, chatId: string): string {
		return join(this.agentDir, "gateway", platform, "chats", sanitizePathSegment(chatId), "sessions");
	}

	private read(): AkashaGatewayStateFile {
		const path = this.path;
		if (!existsSync(path)) return { chats: [] };
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
			if (!isStateFile(parsed)) return { chats: [] };
			return parsed;
		} catch {
			return { chats: [] };
		}
	}

	private write(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify(this.state, null, 2), "utf-8");
	}

	private get path(): string {
		return join(this.agentDir, "gateway", "state.json");
	}
}

function sanitizePathSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function isStateFile(value: unknown): value is AkashaGatewayStateFile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return Array.isArray(record.chats);
}
