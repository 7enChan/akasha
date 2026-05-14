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

export interface AkashaGatewayDeliveryReceipt {
	messageId?: string;
}

export interface AkashaGatewayCommandMenuItem {
	command: string;
	description: string;
}

export interface AkashaGatewayBotProfile {
	description: string;
	shortDescription: string;
}

export interface AkashaGatewayPlatformAdapter {
	name: AkashaGatewayPlatform;
	start(): Promise<void>;
	stop(): Promise<void>;
	sendMessage(message: AkashaGatewayOutgoingMessage): Promise<AkashaGatewayDeliveryReceipt | undefined>;
	sendChatAction?(chatId: string, action?: "typing"): Promise<void>;
	setCommands?(commands: AkashaGatewayCommandMenuItem[]): Promise<void>;
	setBotProfile?(profile: AkashaGatewayBotProfile): Promise<void>;
	sendMedia?(chatId: string, filePath: string, caption?: string): Promise<AkashaGatewayDeliveryReceipt | undefined>;
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

export type AkashaGatewayInboxState = "queued" | "running" | "succeeded" | "failed" | "dead_letter";
export type AkashaGatewayInboxItemKind = "message" | "command" | "callback";
export type AkashaGatewayOutboxState = "queued" | "sending" | "sent" | "failed" | "dead_letter";
export type AkashaGatewayOutboxKind = "text" | "media";

export interface AkashaGatewayDeliveryTarget {
	platform: AkashaGatewayPlatform;
	chatId: string;
}

export interface AkashaGatewayInboxEvent {
	recordType: "gateway.inbox";
	messageKey: string;
	itemKind?: AkashaGatewayInboxItemKind;
	state: AkashaGatewayInboxState;
	attempt: number;
	eventTime: string;
	leaseExpiresAt?: string;
	message?: AkashaGatewayIncomingMessage;
	chat?: AkashaGatewayChatState;
	error?: string;
	outboxIds?: string[];
	sourceEventId?: string;
}

export interface AkashaGatewayOutboxEvent {
	recordType: "gateway.outbox";
	outboxId: string;
	target: AkashaGatewayDeliveryTarget;
	kind: AkashaGatewayOutboxKind;
	state: AkashaGatewayOutboxState;
	attempt: number;
	eventTime: string;
	text?: string;
	filePath?: string;
	caption?: string;
	nextAttemptAt?: string;
	telegramMessageId?: string;
	error?: string;
	sourceMessageKey?: string;
	sourceEventId?: string;
}
