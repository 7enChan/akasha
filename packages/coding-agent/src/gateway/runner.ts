import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { buildRunnableCallbacks, runAkashaCallbackRunner } from "../core/akasha/callback-runner.js";
import { buildAkashaDaemonQueue } from "../core/akasha/daemon-queue.js";
import { JsonlAkashaStore } from "../core/akasha/jsonl-store.js";
import { buildAkashaSessionIndex } from "../core/akasha/session-index.js";
import type { ResolvedAkashaSettings } from "../core/settings-manager.js";
import { DefaultAkashaGatewayAgentRunner } from "./agent-runner.js";
import { type ResolveAkashaGatewayConfigOptions, resolveAkashaGatewayConfig } from "./config.js";
import { AkashaGatewayEventWriter } from "./events.js";
import { AkashaGatewayLock, resolveAkashaGatewayLockPath } from "./lock.js";
import { AkashaGatewayLogger } from "./logger.js";
import { extractMediaReferences, splitTelegramText, validateReadableMediaPath } from "./media.js";
import { AkashaGatewayQueue } from "./queue.js";
import { AkashaGatewaySessionStore } from "./session-store.js";
import { TelegramGatewayAdapter } from "./telegram-adapter.js";
import { TelegramClient } from "./telegram-client.js";
import type {
	AkashaGatewayAgentRunner,
	AkashaGatewayChatState,
	AkashaGatewayConfig,
	AkashaGatewayIncomingMessage,
	AkashaGatewayMessageHandler,
	AkashaGatewayPlatformAdapter,
} from "./types.js";

export interface AkashaGatewayRunnerOptions {
	config: AkashaGatewayConfig;
	settings: ResolvedAkashaSettings;
	logger?: AkashaGatewayLogger;
	sessionStore?: AkashaGatewaySessionStore;
	agentRunner?: AkashaGatewayAgentRunner;
	adapter?: AkashaGatewayPlatformAdapter;
	lock?: AkashaGatewayLock;
}

export class AkashaGatewayRunner implements AkashaGatewayMessageHandler {
	private readonly logger: AkashaGatewayLogger;
	private readonly sessionStore: AkashaGatewaySessionStore;
	private readonly agentRunner: AkashaGatewayAgentRunner;
	private readonly queue = new AkashaGatewayQueue();
	private readonly events: AkashaGatewayEventWriter;
	private readonly lock: AkashaGatewayLock;
	private adapter: AkashaGatewayPlatformAdapter;
	private callbackTimer: NodeJS.Timeout | undefined;

	constructor(private readonly options: AkashaGatewayRunnerOptions) {
		this.logger = options.logger ?? new AkashaGatewayLogger(options.config.agentDir);
		this.sessionStore = options.sessionStore ?? new AkashaGatewaySessionStore(options.config.agentDir);
		this.agentRunner =
			options.agentRunner ?? new DefaultAkashaGatewayAgentRunner({ agentDir: options.config.agentDir });
		this.events = new AkashaGatewayEventWriter({
			agentDir: options.config.agentDir,
			settings: {
				eventLogDir: options.settings.eventLogDir,
				privacy: options.settings.privacy,
			},
		});
		this.lock = options.lock ?? new AkashaGatewayLock(resolveAkashaGatewayLockPath(options.config.agentDir));
		this.adapter = options.adapter ?? this.createTelegramAdapter();
	}

	async start(): Promise<void> {
		this.lock.acquire();
		this.events.appendGateway("telegram", {
			kind: "gateway.started",
			subjectId: "akasha.gateway",
			sourceKey: `gateway-started:telegram:${new Date().toISOString()}`,
			payload: {
				mode: this.options.config.telegram.mode,
				defaultCwd: this.options.config.defaultCwd,
			},
			ttlPolicy: "long_term",
			importance: 0.7,
		});
		this.callbackTimer = setInterval(() => {
			void this.deliverDueCallbacks().catch((error) =>
				this.logger.warn(`Callback delivery failed: ${errorMessage(error)}`),
			);
		}, 60_000);
		await this.deliverDueCallbacks().catch((error) =>
			this.logger.warn(`Initial callback delivery failed: ${errorMessage(error)}`),
		);
		try {
			await this.adapter.start();
		} finally {
			await this.stop();
		}
	}

	async stop(): Promise<void> {
		if (this.callbackTimer) {
			clearInterval(this.callbackTimer);
			this.callbackTimer = undefined;
		}
		await this.adapter.stop().catch(() => undefined);
		this.events.appendGateway("telegram", {
			kind: "gateway.stopped",
			subjectId: "akasha.gateway",
			sourceKey: `gateway-stopped:telegram:${new Date().toISOString()}`,
			payload: {},
			ttlPolicy: "long_term",
			importance: 0.6,
		});
		this.lock.release();
	}

	async handle(message: AkashaGatewayIncomingMessage): Promise<void> {
		const chat = this.sessionStore.getChat(message.platform, message.chatId, this.options.config.defaultCwd);
		if (typeof message.updateId === "number") {
			this.sessionStore.setLastUpdateId(
				message.platform,
				message.chatId,
				message.updateId,
				this.options.config.defaultCwd,
			);
		}
		this.events.appendForChat(chat, {
			kind: "gateway.update.received",
			subjectId: "telegram.update",
			objectId: message.messageId,
			sourceKey: `gateway-update:${message.platform}:${message.updateId ?? message.messageId}`,
			payload: safeMessagePayload(message),
			ttlPolicy: "long_term",
			importance: 0.45,
		});

		if (!message.userId || !this.options.config.telegram.allowedUsers.has(message.userId)) {
			this.events.appendForChat(chat, {
				kind: "gateway.message.rejected",
				subjectId: "telegram.user",
				objectId: message.userId ? String(message.userId) : undefined,
				sourceKey: `gateway-message-rejected:${message.platform}:${message.messageId}`,
				payload: {
					reason: "user_not_allowed",
					messageId: message.messageId,
					userId: message.userId,
					username: message.username,
				},
				ttlPolicy: "long_term",
				importance: 0.75,
			});
			await this.adapter.sendMessage({
				chatId: message.chatId,
				text: "Akasha gateway is not configured for this Telegram user.",
			});
			return;
		}

		const command = parseGatewayCommand(message.text);
		if (command) {
			await this.handleCommand(chat, message, command);
			return;
		}

		this.events.appendForChat(chat, {
			kind: "gateway.message.accepted",
			subjectId: "telegram.message",
			objectId: message.messageId,
			sourceKey: `gateway-message-accepted:${message.platform}:${message.messageId}`,
			payload: safeMessagePayload(message),
			ttlPolicy: "long_term",
			importance: 0.65,
		});
		void this.queue.enqueue(chat.chatId, async () => {
			const stopTypingIndicator = this.startTypingIndicator(chat.chatId);
			try {
				const result = await this.agentRunner.run({ chat, message });
				await this.deliverAgentReply(chat, result.text);
				this.events.appendForChat(chat, {
					kind: "gateway.reply.sent",
					subjectId: "akasha.gateway",
					objectId: result.sessionId,
					sourceKey: `gateway-reply-sent:${message.platform}:${message.messageId}:${result.sessionId}`,
					payload: {
						messageId: message.messageId,
						sessionId: result.sessionId,
						sessionFile: result.sessionFile,
						textLength: result.text.length,
					},
					ttlPolicy: "long_term",
					importance: 0.7,
				});
			} catch (error) {
				this.events.appendForChat(chat, {
					kind: "gateway.delivery.failed",
					subjectId: "akasha.gateway",
					objectId: message.messageId,
					sourceKey: `gateway-agent-failed:${message.platform}:${message.messageId}`,
					payload: {
						reason: errorMessage(error),
						messageId: message.messageId,
					},
					ttlPolicy: "long_term",
					importance: 0.9,
				});
				await this.adapter.sendMessage({ chatId: chat.chatId, text: `Akasha failed: ${errorMessage(error)}` });
			} finally {
				stopTypingIndicator();
			}
		});
	}

	statusText(): string {
		const queueItems = this.countDaemonQueueItems();
		const runnable = this.countRunnableCallbacks();
		const chats = this.sessionStore.listChats().length;
		return [
			"Akasha gateway status",
			`- mode: ${this.options.config.telegram.mode}`,
			`- default cwd: ${this.options.config.defaultCwd}`,
			`- chats: ${chats}`,
			`- busy chats: ${this.queue.pendingKeys().length}`,
			`- daemon queue items: ${queueItems}`,
			`- runnable callbacks: ${runnable}`,
		].join("\n");
	}

	private async handleCommand(
		chat: AkashaGatewayChatState,
		message: AkashaGatewayIncomingMessage,
		command: { name: string; args: string },
	): Promise<void> {
		this.events.appendForChat(chat, {
			kind: "gateway.command.executed",
			subjectId: "telegram.command",
			objectId: command.name,
			sourceKey: `gateway-command:${message.platform}:${message.messageId}:${command.name}`,
			payload: {
				command: command.name,
				args: command.args,
				messageId: message.messageId,
			},
			ttlPolicy: "long_term",
			importance: 0.65,
		});
		if (command.name === "start") {
			await this.adapter.sendMessage({
				chatId: chat.chatId,
				text: "Akasha gateway is online. Use /status, /new, /setcwd <path>, or send a task.",
			});
			return;
		}
		if (command.name === "status") {
			await this.adapter.sendMessage({ chatId: chat.chatId, text: this.statusText() });
			return;
		}
		if (command.name === "new") {
			this.sessionStore.resetSession(chat.platform, chat.chatId, this.options.config.defaultCwd);
			await this.adapter.sendMessage({ chatId: chat.chatId, text: "Started a new Akasha gateway session." });
			return;
		}
		if (command.name === "stop") {
			const stopped = await this.agentRunner.stop(chat.chatId);
			await this.adapter.sendMessage({
				chatId: chat.chatId,
				text: stopped ? "Stopped the active Akasha run." : "No active Akasha run for this chat.",
			});
			return;
		}
		if (command.name === "setcwd") {
			const cwd = resolve(command.args.trim());
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
				await this.adapter.sendMessage({ chatId: chat.chatId, text: `Directory not found: ${cwd}` });
				return;
			}
			this.sessionStore.setCwd(chat.platform, chat.chatId, cwd, this.options.config.defaultCwd);
			await this.adapter.sendMessage({ chatId: chat.chatId, text: `Akasha gateway cwd set to ${cwd}` });
			return;
		}
		await this.adapter.sendMessage({ chatId: chat.chatId, text: `Unknown Akasha gateway command: /${command.name}` });
	}

	private async deliverAgentReply(chat: AkashaGatewayChatState, text: string): Promise<void> {
		const extracted = extractMediaReferences(text);
		for (const chunk of splitTelegramText(extracted.text || "(No text response.)")) {
			await this.adapter.sendMessage({ chatId: chat.chatId, text: chunk });
		}
		for (const media of extracted.media) {
			const readable = validateReadableMediaPath(media.path);
			if (!readable.ok || !this.adapter.sendMedia) {
				await this.adapter.sendMessage({
					chatId: chat.chatId,
					text: `Could not send media ${media.path}: ${readable.ok ? "adapter does not support media" : readable.reason}`,
				});
				continue;
			}
			await this.adapter.sendMedia(chat.chatId, media.path);
		}
	}

	private startTypingIndicator(chatId: string): () => void {
		const sendTyping = () => {
			const promise = this.adapter.sendChatAction?.(chatId, "typing");
			if (!promise) return;
			promise.catch((error) => {
				this.logger.warn(`Telegram typing indicator failed: ${errorMessage(error)}`);
			});
		};
		void sendTyping();
		const timer = setInterval(() => void sendTyping(), 4000);
		return () => clearInterval(timer);
	}

	private async deliverDueCallbacks(): Promise<void> {
		const homeChatId = this.options.config.telegram.homeChatId;
		if (!homeChatId) return;
		for (const session of buildAkashaSessionIndex({
			agentDir: this.options.config.agentDir,
			eventLogDir: this.options.settings.eventLogDir,
			cwd: this.options.config.defaultCwd,
		})) {
			const store = new JsonlAkashaStore(session.eventLogPath);
			const result = runAkashaCallbackRunner(store, {
				reflection: this.options.settings.reflection,
				dispatchMode: "record_only",
				agentDir: this.options.config.agentDir,
			});
			for (const event of result.dispatched) {
				const summary = typeof event.payload.summary === "string" ? event.payload.summary : event.eventId;
				await this.adapter.sendMessage({ chatId: String(homeChatId), text: `Akasha callback due:\n${summary}` });
				this.events.appendGateway("telegram", {
					kind: "gateway.callback.delivered",
					subjectId: "akasha.gateway",
					objectId: String(homeChatId),
					sourceKey: `gateway-callback-delivered:${event.eventId}`,
					parentEventIds: [event.eventId],
					payload: {
						chatId: String(homeChatId),
						dispatchEventId: event.eventId,
						callbackId: event.payload.callbackId,
						summary,
					},
					ttlPolicy: "long_term",
					importance: 0.8,
				});
			}
		}
	}

	private createTelegramAdapter(): TelegramGatewayAdapter {
		const token = this.options.config.telegram.botToken;
		if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
		const client = new TelegramClient({ token });
		const lastUpdateId = this.sessionStore.getLastUpdateId("telegram");
		return new TelegramGatewayAdapter({
			config: this.options.config,
			client,
			handler: this,
			logger: this.logger,
			initialOffset: lastUpdateId === undefined ? undefined : lastUpdateId + 1,
		});
	}

	private countDaemonQueueItems(): number {
		return buildAkashaSessionIndex({
			agentDir: this.options.config.agentDir,
			eventLogDir: this.options.settings.eventLogDir,
			cwd: this.options.config.defaultCwd,
		}).reduce((total, session) => {
			const store = new JsonlAkashaStore(session.eventLogPath);
			return (
				total +
				buildAkashaDaemonQueue(store.buildTimeline({ limit: 1000 }), {
					reflection: this.options.settings.reflection,
				}).length
			);
		}, 0);
	}

	private countRunnableCallbacks(): number {
		return buildAkashaSessionIndex({
			agentDir: this.options.config.agentDir,
			eventLogDir: this.options.settings.eventLogDir,
			cwd: this.options.config.defaultCwd,
		}).reduce((total, session) => {
			const store = new JsonlAkashaStore(session.eventLogPath);
			return total + buildRunnableCallbacks(store.buildTimeline({ limit: 1000 })).length;
		}, 0);
	}
}

export function createAkashaGatewayRunnerFromSettings(options: ResolveAkashaGatewayConfigOptions): {
	runner?: AkashaGatewayRunner;
	status: ReturnType<typeof resolveAkashaGatewayConfig>;
} {
	const status = resolveAkashaGatewayConfig(options);
	if (!status.ok) return { status };
	return {
		status,
		runner: new AkashaGatewayRunner({
			config: status.config,
			settings: options.settings,
		}),
	};
}

function parseGatewayCommand(text: string): { name: string; args: string } | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const [nameWithBot = "", ...rest] = trimmed.slice(1).split(/\s+/);
	const name = nameWithBot.split("@")[0].toLowerCase();
	if (!["start", "status", "new", "stop", "setcwd"].includes(name)) return undefined;
	return { name, args: rest.join(" ") };
}

function safeMessagePayload(message: AkashaGatewayIncomingMessage): Record<string, unknown> {
	return {
		messageId: message.messageId,
		updateId: message.updateId,
		userId: message.userId,
		username: message.username,
		textLength: message.text.length,
		fileCount: message.files?.length ?? 0,
		receivedTime: message.receivedTime,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
