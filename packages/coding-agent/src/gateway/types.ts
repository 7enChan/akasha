import type { ImageContent } from "@earendil-works/akasha-ai";
import type { AkashaGatewayCallbackMode } from "../core/settings-manager.js";

export type AkashaGatewayPlatform = "telegram";
export type AkashaGatewayMode = "polling" | "webhook";

export interface AkashaGatewayTelegramConfig {
	enabled: boolean;
	mode: AkashaGatewayMode;
	botToken?: string;
	allowedUsers: Set<number>;
	homeChatId?: number;
	webhookUrl?: string;
	webhookSecret?: string;
	webhookPort: number;
}

export interface AkashaGatewayConfig {
	enabled: boolean;
	agentDir: string;
	defaultCwd: string;
	callbackMode: AkashaGatewayCallbackMode;
	telegram: AkashaGatewayTelegramConfig;
}

export interface AkashaGatewayConfigStatus {
	ok: boolean;
	missing: string[];
	warnings: string[];
	config: AkashaGatewayConfig;
}

export interface AkashaGatewayChatState {
	platform: AkashaGatewayPlatform;
	chatId: string;
	cwd: string;
	sessionDir: string;
	lastUpdateId?: number;
	updatedAt: string;
}

export interface AkashaGatewayIncomingMessage {
	platform: AkashaGatewayPlatform;
	chatId: string;
	messageId: string;
	userId?: number;
	username?: string;
	text: string;
	images?: ImageContent[];
	files?: AkashaGatewayDownloadedFile[];
	updateId?: number;
	receivedTime: string;
	raw?: unknown;
}

export interface AkashaGatewayDownloadedFile {
	fileId: string;
	path: string;
	mimeType?: string;
	fileName?: string;
	kind: "document" | "image" | "voice" | "other";
	text?: string;
}

export interface AkashaGatewayOutgoingMessage {
	chatId: string;
	text: string;
}

export interface AkashaGatewayCommandMenuItem {
	command: string;
	description: string;
}

export interface AkashaGatewayPlatformAdapter {
	name: AkashaGatewayPlatform;
	start(): Promise<void>;
	stop(): Promise<void>;
	sendMessage(message: AkashaGatewayOutgoingMessage): Promise<void>;
	sendChatAction?(chatId: string, action?: "typing"): Promise<void>;
	setCommands?(commands: AkashaGatewayCommandMenuItem[]): Promise<void>;
	sendMedia?(chatId: string, filePath: string, caption?: string): Promise<void>;
}

export interface AkashaGatewayMessageHandler {
	handle(message: AkashaGatewayIncomingMessage): Promise<void>;
}

export interface AkashaGatewayAgentResult {
	text: string;
	sessionId: string;
	sessionFile?: string;
}

export interface AkashaGatewayAgentRunInput {
	chat: AkashaGatewayChatState;
	message: AkashaGatewayIncomingMessage;
}

export interface AkashaGatewayAgentRunner {
	run(input: AkashaGatewayAgentRunInput): Promise<AkashaGatewayAgentResult>;
	stop(chatId: string): Promise<boolean>;
}
