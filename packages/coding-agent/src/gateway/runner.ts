import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type AkashaCallbackDispatchMode,
	buildRunnableCallbacks,
	runAkashaCallbackRunner,
} from "../core/akasha/callback-runner.js";
import { buildAkashaDaemonQueue } from "../core/akasha/daemon-queue.js";
import { JsonlAkashaStore } from "../core/akasha/jsonl-store.js";
import { rulesForAkashaPolicyProfile } from "../core/akasha/policy-kernel.js";
import { buildAkashaSessionIndex } from "../core/akasha/session-index.js";
import type { AkashaEvent } from "../core/akasha/types.js";
import { AuthStorage } from "../core/auth-storage.js";
import { ModelRegistry } from "../core/model-registry.js";
import {
	type AkashaGatewayCallbackMode,
	type ResolvedAkashaSettings,
	SettingsManager,
} from "../core/settings-manager.js";
import { DefaultAkashaGatewayAgentRunner } from "./agent-runner.js";
import { type ResolveAkashaGatewayConfigOptions, resolveAkashaGatewayConfig } from "./config.js";
import { AkashaGatewayDeliveryDriver } from "./delivery.js";
import { AkashaGatewayEventWriter } from "./events.js";
import { AKASHA_GATEWAY_INBOX_MAX_ATTEMPTS, AkashaGatewayInboxStore, akashaGatewayMessageKey } from "./inbox-store.js";
import { AkashaGatewayLock, resolveAkashaGatewayLockPath } from "./lock.js";
import { AkashaGatewayLogger } from "./logger.js";
import { extractMediaReferences, splitTelegramText } from "./media.js";
import { AkashaGatewayOutboxStore } from "./outbox-store.js";
import { AkashaGatewayQueue } from "./queue.js";
import {
	type AkashaGatewayPlatformRuntimeState,
	readAkashaGatewayRuntimeStatus,
	writeAkashaGatewayRuntimeStatus,
} from "./runtime-status.js";
import { AkashaGatewaySessionStore } from "./session-store.js";
import { TelegramGatewayAdapter } from "./telegram-adapter.js";
import { TelegramClient } from "./telegram-client.js";
import type {
	AkashaGatewayAgentRunner,
	AkashaGatewayChatState,
	AkashaGatewayCommandMenuItem,
	AkashaGatewayConfig,
	AkashaGatewayInboxEvent,
	AkashaGatewayIncomingMessage,
	AkashaGatewayMessageHandler,
	AkashaGatewayOutboxEvent,
	AkashaGatewayPlatformAdapter,
} from "./types.js";

export const AKASHA_TELEGRAM_MENU_COMMANDS: AkashaGatewayCommandMenuItem[] = [
	{ command: "new", description: "Start a new Akasha session" },
	{ command: "model", description: "View or switch the model" },
	{ command: "thinking", description: "View or switch thinking level" },
	{ command: "stop", description: "Stop the active run" },
	{ command: "timeline", description: "Show recent Akasha time events" },
];

const AKASHA_START_MESSAGE = "Akasha is awake.\nKnowing. Doing. Being.";
const AKASHA_BOT_PROFILE_DESCRIPTION = "Akasha: Knowing. Doing. Being.";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type GatewayThinkingLevel = (typeof THINKING_LEVELS)[number];

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
	private readonly inbox: AkashaGatewayInboxStore;
	private readonly outbox: AkashaGatewayOutboxStore;
	private readonly delivery: AkashaGatewayDeliveryDriver;
	private readonly runtimeStartedAt = new Date().toISOString();
	private adapter: AkashaGatewayPlatformAdapter;
	private callbackTimer: NodeJS.Timeout | undefined;
	private inboxTimer: NodeJS.Timeout | undefined;
	private outboxTimer: NodeJS.Timeout | undefined;
	private inboxDrainPromise: Promise<void> | undefined;
	private outboxDrainPromise: Promise<void> | undefined;

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
		this.lock =
			options.lock ??
			new AkashaGatewayLock(resolveAkashaGatewayLockPath(options.config.agentDir), {
				telegramBotToken: options.config.telegram.botToken,
			});
		this.adapter = options.adapter ?? this.createTelegramAdapter();
		this.inbox = new AkashaGatewayInboxStore(options.config.agentDir);
		this.outbox = new AkashaGatewayOutboxStore(options.config.agentDir);
		this.delivery = new AkashaGatewayDeliveryDriver({
			outbox: this.outbox,
			adapter: this.adapter,
			events: this.events,
		});
	}

	async start(): Promise<void> {
		this.lock.acquire();
		this.writeRuntimeStatus("starting", "starting");
		await this.registerCommandMenu();
		await this.registerBotProfile();
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
		this.startDrainTimers();
		await this.drainInbox().catch((error) => this.recordRuntimeError(error, "Initial inbox drain failed"));
		await this.drainOutbox().catch((error) => this.recordRuntimeError(error, "Initial outbox drain failed"));
		this.callbackTimer = setInterval(() => {
			void this.deliverDueCallbacks().catch((error) =>
				this.logger.warn(`Callback delivery failed: ${errorMessage(error)}`),
			);
		}, 60_000);
		await this.deliverDueCallbacks().catch((error) =>
			this.logger.warn(`Initial callback delivery failed: ${errorMessage(error)}`),
		);
		this.writeRuntimeStatus("running", platformRuntimeState(this.options.config.telegram.mode));
		try {
			await this.adapter.start();
		} finally {
			await this.stop();
		}
	}

	async stop(): Promise<void> {
		this.writeRuntimeStatus("stopping", platformRuntimeState(this.options.config.telegram.mode));
		if (this.callbackTimer) {
			clearInterval(this.callbackTimer);
			this.callbackTimer = undefined;
		}
		if (this.inboxTimer) {
			clearInterval(this.inboxTimer);
			this.inboxTimer = undefined;
		}
		if (this.outboxTimer) {
			clearInterval(this.outboxTimer);
			this.outboxTimer = undefined;
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
		this.writeRuntimeStatus("stopped", "stopped");
		this.lock.release();
	}

	async handle(message: AkashaGatewayIncomingMessage): Promise<void> {
		const chat = this.sessionStore.getChat(message.platform, message.chatId, this.options.config.defaultCwd);
		const messageKey = akashaGatewayMessageKey(message);
		this.events.appendForChat(chat, {
			kind: "gateway.update.received",
			subjectId: "telegram.update",
			objectId: message.messageId,
			sourceKey: `gateway-update:${messageKey}`,
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
			await this.sendGatewayText(
				chat,
				"Akasha gateway is not configured for this Telegram user.",
				`${messageKey}:rejected`,
			);
			this.recordLastUpdate(message);
			return;
		}

		const command = parseGatewayCommand(message.text);
		if (command) {
			await this.handleJournaledCommand(chat, message, command, messageKey);
			this.recordLastUpdate(message);
			return;
		}

		const queued = this.inbox.enqueue({ chat, message, messageKey, itemKind: "message" });
		if (queued.enqueued) {
			this.emitInboxQueued(queued.record);
		}
		if (queued.record.state === "succeeded" || queued.record.state === "dead_letter") {
			this.recordLastUpdate(message);
			this.writeRuntimeStatus("running", platformRuntimeState(this.options.config.telegram.mode));
			return;
		}
		this.events.appendForChat(chat, {
			kind: "gateway.message.accepted",
			subjectId: "telegram.message",
			objectId: message.messageId,
			sourceKey: `gateway-message-accepted:${messageKey}`,
			payload: safeMessagePayload(message),
			ttlPolicy: "long_term",
			importance: 0.65,
		});
		void this.drainInbox().catch((error) => this.recordRuntimeError(error, "Gateway inbox drain failed"));
		this.recordLastUpdate(message);
	}

	statusText(): string {
		const queueItems = this.countDaemonQueueItems();
		const runnable = this.countRunnableCallbacks();
		const chats = this.sessionStore.listChats().length;
		const inboxCounts = this.inbox.counts();
		const outboxCounts = this.outbox.counts();
		return [
			"Akasha gateway status",
			`- mode: ${this.options.config.telegram.mode}`,
			`- callback mode: ${this.options.config.callbackMode}`,
			`- default cwd: ${this.options.config.defaultCwd}`,
			`- chats: ${chats}`,
			`- busy chats: ${this.queue.pendingKeys().length}`,
			`- pending inbox: ${inboxCounts.pending}`,
			`- pending outbox: ${outboxCounts.pending}`,
			`- dead letters: ${inboxCounts.deadLetters + outboxCounts.deadLetters}`,
			`- daemon queue items: ${queueItems}`,
			`- runnable callbacks: ${runnable}`,
		].join("\n");
	}

	private async handleJournaledCommand(
		chat: AkashaGatewayChatState,
		message: AkashaGatewayIncomingMessage,
		command: { name: string; args: string },
		messageKey: string,
	): Promise<void> {
		const queued = this.inbox.enqueue({ chat, message, messageKey, itemKind: "command" });
		if (queued.enqueued) this.emitInboxQueued(queued.record);
		if (
			queued.record.state === "running" ||
			queued.record.state === "succeeded" ||
			queued.record.state === "dead_letter"
		) {
			return;
		}
		const running = this.inbox.markRunning(messageKey);
		this.emitInboxRunning(running);
		try {
			await this.handleCommand(chat, message, command, messageKey);
			this.inbox.markSucceeded(messageKey);
		} catch (error) {
			if (running.attempt >= AKASHA_GATEWAY_INBOX_MAX_ATTEMPTS) {
				this.emitInboxDeadLetter(this.inbox.markDeadLetter(messageKey, errorMessage(error)));
			} else {
				this.inbox.markFailed(messageKey, errorMessage(error));
			}
			throw error;
		}
	}

	private async handleCommand(
		chat: AkashaGatewayChatState,
		message: AkashaGatewayIncomingMessage,
		command: { name: string; args: string },
		messageKey: string,
	): Promise<void> {
		this.events.appendForChat(chat, {
			kind: "gateway.command.executed",
			subjectId: "telegram.command",
			objectId: command.name,
			sourceKey: `gateway-command:${messageKey}:${command.name}`,
			payload: {
				command: command.name,
				args: command.args,
				messageId: message.messageId,
			},
			ttlPolicy: "long_term",
			importance: 0.65,
		});
		if (command.name === "start") {
			await this.sendGatewayText(chat, AKASHA_START_MESSAGE, `${messageKey}:command:start`);
			return;
		}
		if (command.name === "status") {
			await this.sendGatewayText(chat, this.statusText(), `${messageKey}:command:status`);
			return;
		}
		if (command.name === "new") {
			this.sessionStore.resetSession(chat.platform, chat.chatId, this.options.config.defaultCwd, messageKey);
			await this.sendGatewayText(chat, "Started a new Akasha gateway session.", `${messageKey}:command:new`);
			return;
		}
		if (command.name === "stop") {
			const stopped = await this.agentRunner.stop(chat.chatId);
			await this.sendGatewayText(
				chat,
				stopped ? "Stopped the active Akasha run." : "No active Akasha run for this chat.",
				`${messageKey}:command:stop`,
			);
			return;
		}
		if (command.name === "model") {
			await this.sendGatewayText(
				chat,
				await this.handleModelCommand(chat, command.args),
				`${messageKey}:command:model`,
			);
			return;
		}
		if (command.name === "thinking") {
			await this.sendGatewayText(
				chat,
				await this.handleThinkingCommand(chat, command.args),
				`${messageKey}:command:thinking`,
			);
			return;
		}
		if (command.name === "timeline") {
			await this.sendGatewayText(
				chat,
				this.handleTimelineCommand(chat, command.args),
				`${messageKey}:command:timeline`,
			);
			return;
		}
		if (command.name === "setcwd") {
			const cwd = resolve(command.args.trim());
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
				await this.sendGatewayText(chat, `Directory not found: ${cwd}`, `${messageKey}:command:setcwd:not-found`);
				return;
			}
			this.sessionStore.setCwd(chat.platform, chat.chatId, cwd, this.options.config.defaultCwd);
			await this.sendGatewayText(chat, `Akasha gateway cwd set to ${cwd}`, `${messageKey}:command:setcwd`);
			return;
		}
		await this.sendGatewayText(
			chat,
			`Unknown Akasha gateway command: /${command.name}`,
			`${messageKey}:command:unknown`,
		);
	}

	private async handleModelCommand(chat: AkashaGatewayChatState, args: string): Promise<string> {
		const settingsManager = SettingsManager.create(chat.cwd, this.options.config.agentDir);
		const currentProvider = settingsManager.getDefaultProvider();
		const currentModel = settingsManager.getDefaultModel();
		const registry = this.createModelRegistry();
		const requested = parseModelSelection(args, currentProvider);
		if (!requested) {
			const available = registry.getAvailable().slice(0, 12);
			const lines = [`Current model: ${formatCurrentModel(currentProvider, currentModel)}`, "", "Available models:"];
			if (available.length === 0) {
				lines.push("- (none with configured auth)");
			} else {
				for (const model of available) {
					lines.push(`- ${model.provider}/${model.id}${model.name === model.id ? "" : ` (${model.name})`}`);
				}
			}
			lines.push("", "Switch with: /model <provider>/<modelId>");
			return lines.join("\n");
		}

		const model = registry.find(requested.provider, requested.modelId);
		if (!model) {
			return `Model not found: ${requested.provider}/${requested.modelId}\nUse /model to list available models.`;
		}
		if (!registry.hasConfiguredAuth(model)) {
			return `Model exists but auth is not configured: ${requested.provider}/${requested.modelId}`;
		}
		settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		await settingsManager.flush();
		return `Model switched to ${model.provider}/${model.id}`;
	}

	private async handleThinkingCommand(chat: AkashaGatewayChatState, args: string): Promise<string> {
		const settingsManager = SettingsManager.create(chat.cwd, this.options.config.agentDir);
		const requested = args.trim().toLowerCase();
		if (!requested) {
			return [
				`Current thinking level: ${settingsManager.getDefaultThinkingLevel() ?? "off"}`,
				`Available: ${THINKING_LEVELS.join(", ")}`,
				"",
				"Switch with: /thinking <level>",
			].join("\n");
		}
		if (!isGatewayThinkingLevel(requested)) {
			return `Invalid thinking level: ${requested}\nAvailable: ${THINKING_LEVELS.join(", ")}`;
		}
		settingsManager.setDefaultThinkingLevel(requested);
		await settingsManager.flush();
		return `Thinking level switched to ${requested}`;
	}

	private handleTimelineCommand(chat: AkashaGatewayChatState, args: string): string {
		const limit = clampTimelineLimit(args);
		const events = this.collectTimelineEvents(chat.cwd, limit);
		if (events.length === 0) return "Akasha timeline:\n- (no events yet)";
		return [`Akasha timeline: last ${events.length} events`, ...events.map(formatTimelineEvent)].join("\n");
	}

	private enqueueAgentReply(chat: AkashaGatewayChatState, text: string, sourceMessageKey: string): string[] {
		const extracted = extractMediaReferences(text);
		const outboxIds: string[] = [];
		let index = 0;
		for (const chunk of splitTelegramText(extracted.text || "(No text response.)")) {
			const queued = this.outbox.enqueueText({
				target: { platform: chat.platform, chatId: chat.chatId },
				outboxId: `${sourceMessageKey}:reply:text:${index}`,
				sourceMessageKey,
				text: chunk,
			});
			if (queued.enqueued) this.emitOutboxQueued(queued.record);
			outboxIds.push(queued.record.outboxId);
			index++;
		}
		let mediaIndex = 0;
		for (const media of extracted.media) {
			const queued = this.outbox.enqueueMedia({
				target: { platform: chat.platform, chatId: chat.chatId },
				outboxId: `${sourceMessageKey}:reply:media:${mediaIndex}`,
				sourceMessageKey,
				filePath: media.path,
			});
			if (queued.enqueued) this.emitOutboxQueued(queued.record);
			outboxIds.push(queued.record.outboxId);
			mediaIndex++;
		}
		return outboxIds;
	}

	private async sendGatewayText(
		chat: AkashaGatewayChatState,
		text: string,
		sourceMessageKey: string,
	): Promise<string[]> {
		const outboxIds: string[] = [];
		let index = 0;
		for (const chunk of splitTelegramText(text)) {
			const queued = this.outbox.enqueueText({
				target: { platform: chat.platform, chatId: chat.chatId },
				outboxId: `${sourceMessageKey}:text:${index}`,
				sourceMessageKey,
				text: chunk,
			});
			if (queued.enqueued) this.emitOutboxQueued(queued.record);
			outboxIds.push(queued.record.outboxId);
			index++;
		}
		await this.drainOutbox();
		return outboxIds;
	}

	async drainInbox(): Promise<void> {
		if (this.inboxDrainPromise) return this.inboxDrainPromise;
		this.inboxDrainPromise = this.runInboxDrain().finally(() => {
			this.inboxDrainPromise = undefined;
		});
		return this.inboxDrainPromise;
	}

	async drainOutbox(): Promise<void> {
		if (this.outboxDrainPromise) return this.outboxDrainPromise;
		this.outboxDrainPromise = this.delivery.drainDue().finally(() => {
			this.outboxDrainPromise = undefined;
			this.writeRuntimeStatus("running", platformRuntimeState(this.options.config.telegram.mode));
		});
		return this.outboxDrainPromise;
	}

	private async runInboxDrain(): Promise<void> {
		for (const candidate of this.inbox.listDeadLetterCandidates()) {
			this.emitInboxDeadLetter(this.inbox.markDeadLetter(candidate.messageKey, "inbox retry limit exceeded"));
		}
		const runnable = this.inbox.listRunnable();
		await Promise.all(
			runnable.map((record) => {
				const chatId = record.chat?.chatId ?? record.message?.chatId;
				if (!chatId) {
					this.emitInboxDeadLetter(this.inbox.markDeadLetter(record.messageKey, "inbox item missing chat"));
					return Promise.resolve();
				}
				return this.queue.enqueue(chatId, async () => this.processInboxRecord(record.messageKey));
			}),
		);
		this.writeRuntimeStatus("running", platformRuntimeState(this.options.config.telegram.mode));
	}

	private async processInboxRecord(messageKey: string): Promise<void> {
		const current = this.inbox.project().get(messageKey);
		if (!current || current.state === "succeeded" || current.state === "dead_letter") return;
		if (current.itemKind === "command") {
			this.emitInboxDeadLetter(this.inbox.markDeadLetter(messageKey, "command inbox items are not replayed"));
			return;
		}
		if (current.attempt >= AKASHA_GATEWAY_INBOX_MAX_ATTEMPTS) {
			this.emitInboxDeadLetter(this.inbox.markDeadLetter(messageKey, "inbox retry limit exceeded"));
			return;
		}
		const running = this.inbox.markRunning(messageKey);
		this.emitInboxRunning(running);
		const chat = running.chat;
		const message = running.message;
		if (!chat || !message) {
			this.emitInboxDeadLetter(this.inbox.markDeadLetter(messageKey, "inbox item missing message or chat"));
			return;
		}
		const stopTypingIndicator = this.startTypingIndicator(chat.chatId);
		try {
			const result = await this.agentRunner.run({ chat, message });
			const outboxIds = this.enqueueAgentReply(chat, result.text, messageKey);
			this.inbox.markSucceeded(messageKey, outboxIds);
			this.events.appendForChat(chat, {
				kind: "gateway.reply.sent",
				subjectId: "akasha.gateway",
				objectId: result.sessionId,
				sourceKey: `gateway-reply-sent:${messageKey}:${result.sessionId}`,
				payload: {
					messageId: message.messageId,
					sessionId: result.sessionId,
					sessionFile: result.sessionFile,
					textLength: result.text.length,
					outboxIds,
				},
				ttlPolicy: "long_term",
				importance: 0.7,
			});
			await this.drainOutbox();
		} catch (error) {
			const reason = errorMessage(error);
			const terminal =
				running.attempt >= AKASHA_GATEWAY_INBOX_MAX_ATTEMPTS
					? this.inbox.markDeadLetter(messageKey, reason)
					: this.inbox.markFailed(messageKey, reason);
			if (terminal.state === "dead_letter") this.emitInboxDeadLetter(terminal);
			this.events.appendForChat(chat, {
				kind: "gateway.delivery.failed",
				subjectId: "akasha.gateway",
				objectId: message.messageId,
				sourceKey: `gateway-agent-failed:${messageKey}:${running.attempt}`,
				payload: {
					reason,
					messageId: message.messageId,
					attempt: running.attempt,
					state: terminal.state,
				},
				ttlPolicy: "long_term",
				importance: 0.9,
			});
			await this.sendGatewayText(chat, `Akasha failed: ${reason}`, `${messageKey}:agent-error:${running.attempt}`);
		} finally {
			stopTypingIndicator();
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

	private async registerCommandMenu(): Promise<void> {
		if (!this.adapter.setCommands) return;
		try {
			await this.adapter.setCommands(AKASHA_TELEGRAM_MENU_COMMANDS);
		} catch (error) {
			this.logger.warn(`Telegram command menu registration failed: ${errorMessage(error)}`);
		}
	}

	private async registerBotProfile(): Promise<void> {
		if (!this.adapter.setBotProfile) return;
		try {
			await this.adapter.setBotProfile({
				description: AKASHA_BOT_PROFILE_DESCRIPTION,
				shortDescription: AKASHA_BOT_PROFILE_DESCRIPTION,
			});
		} catch (error) {
			this.logger.warn(`Telegram bot profile sync failed: ${errorMessage(error)}`);
		}
	}

	private startDrainTimers(): void {
		if (!this.inboxTimer) {
			this.inboxTimer = setInterval(() => {
				void this.drainInbox().catch((error) => this.recordRuntimeError(error, "Gateway inbox drain failed"));
			}, 2000);
		}
		if (!this.outboxTimer) {
			this.outboxTimer = setInterval(() => {
				void this.drainOutbox().catch((error) => this.recordRuntimeError(error, "Gateway outbox drain failed"));
			}, 1000);
		}
	}

	private emitInboxQueued(record: AkashaGatewayInboxEvent): void {
		if (!record.chat) return;
		this.events.appendForChat(record.chat, {
			kind: "gateway.message.queued",
			subjectId: "akasha.gateway.inbox",
			objectId: record.message?.messageId,
			sourceKey: `gateway-message-queued:${record.messageKey}`,
			payload: {
				messageKey: record.messageKey,
				itemKind: record.itemKind,
				messageId: record.message?.messageId,
				attempt: record.attempt,
				sourceEventId: record.sourceEventId,
			},
			ttlPolicy: "long_term",
			importance: 0.65,
		});
	}

	private emitInboxRunning(record: AkashaGatewayInboxEvent): void {
		if (!record.chat) return;
		this.events.appendForChat(record.chat, {
			kind: "gateway.message.running",
			subjectId: "akasha.gateway.inbox",
			objectId: record.message?.messageId,
			sourceKey: `gateway-message-running:${record.messageKey}:${record.attempt}`,
			payload: {
				messageKey: record.messageKey,
				itemKind: record.itemKind,
				messageId: record.message?.messageId,
				attempt: record.attempt,
				leaseExpiresAt: record.leaseExpiresAt,
				sourceEventId: record.sourceEventId,
			},
			ttlPolicy: "long_term",
			importance: 0.65,
		});
	}

	private emitInboxDeadLetter(record: AkashaGatewayInboxEvent): void {
		if (!record.chat) return;
		this.events.appendForChat(record.chat, {
			kind: "gateway.message.dead_letter",
			subjectId: "akasha.gateway.inbox",
			objectId: record.message?.messageId,
			sourceKey: `gateway-message-dead-letter:${record.messageKey}`,
			payload: {
				messageKey: record.messageKey,
				itemKind: record.itemKind,
				messageId: record.message?.messageId,
				attempt: record.attempt,
				error: record.error,
				sourceEventId: record.sourceEventId,
			},
			ttlPolicy: "long_term",
			importance: 0.9,
		});
	}

	private emitOutboxQueued(record: AkashaGatewayOutboxEvent): void {
		this.events.appendGateway(record.target.platform, {
			kind: "gateway.outbox.queued",
			subjectId: "akasha.gateway.outbox",
			objectId: record.outboxId,
			sourceKey: `gateway-outbox-queued:${record.outboxId}`,
			payload: {
				outboxId: record.outboxId,
				chatId: record.target.chatId,
				kind: record.kind,
				sourceMessageKey: record.sourceMessageKey,
				sourceEventId: record.sourceEventId,
			},
			ttlPolicy: "long_term",
			importance: 0.6,
		});
	}

	private writeRuntimeStatus(
		gatewayState: "starting" | "running" | "stopping" | "stopped" | "error",
		platformState: AkashaGatewayPlatformRuntimeState,
		lastError?: string,
	): void {
		const inboxCounts = this.inbox.counts();
		const outboxCounts = this.outbox.counts();
		const previous = readAkashaGatewayRuntimeStatus(this.options.config.agentDir);
		writeAkashaGatewayRuntimeStatus(this.options.config.agentDir, {
			pid: process.pid,
			startedAt: this.runtimeStartedAt,
			updatedAt: new Date().toISOString(),
			gatewayState,
			platformState,
			mode: this.options.config.telegram.mode,
			activeChats: this.queue.pendingKeys(),
			pendingInbox: inboxCounts.pending,
			pendingOutbox: outboxCounts.pending,
			deadLetters: inboxCounts.deadLetters + outboxCounts.deadLetters,
			lastUpdateId: this.sessionStore.getLastUpdateId("telegram"),
			lastError: lastError ?? previous?.lastError,
		});
	}

	private recordRuntimeError(error: unknown, prefix: string): void {
		const message = `${prefix}: ${errorMessage(error)}`;
		this.logger.warn(message);
		this.writeRuntimeStatus("error", "error", message);
	}

	private recordLastUpdate(message: AkashaGatewayIncomingMessage): void {
		if (typeof message.updateId !== "number") return;
		this.sessionStore.setLastUpdateId(
			message.platform,
			message.chatId,
			message.updateId,
			this.options.config.defaultCwd,
		);
		this.writeRuntimeStatus("running", platformRuntimeState(this.options.config.telegram.mode));
	}

	private async deliverDueCallbacks(): Promise<void> {
		const homeChatId = this.options.config.telegram.homeChatId;
		if (!homeChatId) return;
		const chat = this.sessionStore.getChat("telegram", String(homeChatId), this.options.config.defaultCwd);
		for (const session of buildAkashaSessionIndex({
			agentDir: this.options.config.agentDir,
			eventLogDir: this.options.settings.eventLogDir,
			cwd: this.options.config.defaultCwd,
		})) {
			const store = new JsonlAkashaStore(session.eventLogPath);
			const result = runAkashaCallbackRunner(store, {
				reflection: this.options.settings.reflection,
				dispatchMode: callbackDispatchModeForGateway(this.options.config.callbackMode),
				agentDir: this.options.config.agentDir,
				rules: rulesForAkashaPolicyProfile(this.options.settings.policyProfile),
			});
			for (const event of result.dispatched) {
				const summary = typeof event.payload.summary === "string" ? event.payload.summary : event.eventId;
				const callbackId = typeof event.payload.callbackId === "string" ? event.payload.callbackId : event.eventId;
				const safeForAutoRun = event.payload.safeForAutoRun === true;
				const autoRun = this.options.config.callbackMode === "auto_run_safe" && safeForAutoRun;
				const outboxIds = await this.sendGatewayText(
					chat,
					formatGatewayCallbackDeliveryText(this.options.config.callbackMode, summary, safeForAutoRun),
					`callback:${callbackId}:notice`,
				);
				let inboxMessageKey: string | undefined;
				if (autoRun) {
					inboxMessageKey = `callback:${callbackId}:auto-run`;
					const message: AkashaGatewayIncomingMessage = {
						platform: "telegram",
						chatId: chat.chatId,
						messageId: inboxMessageKey,
						userId: homeChatId,
						text: formatGatewayCallbackAgentPrompt(event, summary),
						receivedTime: new Date().toISOString(),
						raw: {
							source: "akasha.gateway.callback",
							dispatchEventId: event.eventId,
							callbackId,
						},
					};
					const queued = this.inbox.enqueue({
						chat,
						message,
						messageKey: inboxMessageKey,
						itemKind: "callback",
						sourceEventId: event.eventId,
					});
					if (queued.enqueued) this.emitInboxQueued(queued.record);
					await this.drainInbox();
				}
				if (this.options.config.callbackMode === "notify_only" && !this.outboxIdsSent(outboxIds)) {
					continue;
				}
				this.events.appendGateway("telegram", {
					kind: "gateway.callback.delivered",
					subjectId: "akasha.gateway",
					objectId: String(homeChatId),
					sourceKey: `gateway-callback-delivered:${event.eventId}`,
					parentEventIds: [event.eventId],
					payload: {
						chatId: String(homeChatId),
						dispatchEventId: event.eventId,
						callbackId,
						summary,
						callbackMode: this.options.config.callbackMode,
						safeForAutoRun,
						autoRunAttempted: autoRun,
						inboxMessageKey,
						outboxIds,
					},
					ttlPolicy: "long_term",
					importance: 0.8,
				});
			}
		}
	}

	private outboxIdsSent(outboxIds: string[]): boolean {
		const projection = this.outbox.project();
		return outboxIds.length > 0 && outboxIds.every((id) => projection.get(id)?.state === "sent");
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

	private createModelRegistry(): ModelRegistry {
		return ModelRegistry.create(
			AuthStorage.create(join(this.options.config.agentDir, "auth.json")),
			join(this.options.config.agentDir, "models.json"),
		);
	}

	private collectTimelineEvents(cwd: string, limit: number): AkashaEvent[] {
		const events: AkashaEvent[] = [];
		for (const session of buildAkashaSessionIndex({
			agentDir: this.options.config.agentDir,
			eventLogDir: this.options.settings.eventLogDir,
			cwd,
		})) {
			const store = new JsonlAkashaStore(session.eventLogPath);
			events.push(...store.buildTimeline({ limit }));
		}
		return events.sort(compareEventsByTime).slice(-limit);
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
	if (!["start", "status", "new", "stop", "setcwd", "model", "thinking", "timeline"].includes(name)) return undefined;
	return { name, args: rest.join(" ") };
}

function parseModelSelection(
	args: string,
	currentProvider: string | undefined,
): { provider: string; modelId: string } | undefined {
	const trimmed = args.trim();
	if (!trimmed) return undefined;
	const [first = "", ...rest] = trimmed.split(/\s+/);
	if (rest.length > 0) return { provider: first, modelId: rest.join(" ") };
	const slashIndex = first.indexOf("/");
	if (slashIndex > 0) {
		return {
			provider: first.slice(0, slashIndex),
			modelId: first.slice(slashIndex + 1),
		};
	}
	if (currentProvider) return { provider: currentProvider, modelId: first };
	return undefined;
}

function formatCurrentModel(provider: string | undefined, model: string | undefined): string {
	if (provider && model) return `${provider}/${model}`;
	return "(not set)";
}

function isGatewayThinkingLevel(value: string): value is GatewayThinkingLevel {
	return THINKING_LEVELS.includes(value as GatewayThinkingLevel);
}

function clampTimelineLimit(args: string): number {
	const parsed = Number(args.trim());
	if (!Number.isFinite(parsed)) return 12;
	return Math.max(1, Math.min(30, Math.floor(parsed)));
}

function compareEventsByTime(a: AkashaEvent, b: AkashaEvent): number {
	return eventSortTime(a) - eventSortTime(b);
}

function eventSortTime(event: AkashaEvent): number {
	return Date.parse(event.eventTime || event.recordedTime) || 0;
}

function formatTimelineEvent(event: AkashaEvent): string {
	const time = new Date(eventSortTime(event)).toISOString().replace("T", " ").slice(0, 19);
	const target = event.objectId ?? event.subjectId ?? event.toolCallId ?? event.eventId;
	const summary = summarizeEventPayload(event.payload);
	return `- ${time} ${event.kind}${target ? ` ${target}` : ""}${summary ? `: ${summary}` : ""}`;
}

function callbackDispatchModeForGateway(mode: AkashaGatewayCallbackMode): AkashaCallbackDispatchMode {
	if (mode === "notify_only") return "record_only";
	if (mode === "auto_run_safe") return "auto_run_safe";
	return "agent_prompt_file";
}

function formatGatewayCallbackDeliveryText(
	mode: AkashaGatewayCallbackMode,
	summary: string,
	safeForAutoRun: boolean,
): string {
	if (mode === "inbox_only") {
		return `Akasha callback queued in inbox:\n${summary}`;
	}
	if (mode === "ask_before_run") {
		return [
			"Akasha callback needs review:",
			summary,
			"",
			"It has been queued in Akasha inbox. Reply with instructions when you are ready to act.",
		].join("\n");
	}
	if (mode === "auto_run_safe") {
		return safeForAutoRun
			? `Akasha callback is safe for auto-run:\n${summary}`
			: `Akasha callback queued for manual review:\n${summary}`;
	}
	return `Akasha callback due:\n${summary}`;
}

function formatGatewayCallbackAgentPrompt(dispatchEvent: AkashaEvent, summary: string): string {
	const callbackId = typeof dispatchEvent.payload.callbackId === "string" ? dispatchEvent.payload.callbackId : "";
	const dispatchDetails = dispatchEvent.payload.dispatchDetails;
	const inboxItemId =
		typeof dispatchDetails === "object" &&
		dispatchDetails !== null &&
		"inboxItemId" in dispatchDetails &&
		typeof dispatchDetails.inboxItemId === "string"
			? dispatchDetails.inboxItemId
			: undefined;
	return [
		"Akasha gateway is auto-running a due temporal callback.",
		`summary: ${summary}`,
		callbackId ? `callbackId: ${callbackId}` : undefined,
		inboxItemId ? `inboxItemId: ${inboxItemId}` : undefined,
		"Review the causal chain, act only if still relevant, and close the loop with akasha_resolve_commitment or akasha_check_prediction using the callbackId or inboxItemId.",
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function summarizeEventPayload(payload: Record<string, unknown>): string {
	for (const key of ["summary", "text", "command", "reason", "path", "messageId"]) {
		const value = payload[key];
		if (typeof value === "string" && value.trim()) return truncate(value.trim(), 96);
		if (typeof value === "number") return String(value);
	}
	return "";
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
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

function platformRuntimeState(mode: "polling" | "webhook"): AkashaGatewayPlatformRuntimeState {
	return mode === "polling" ? "polling" : "webhook";
}
