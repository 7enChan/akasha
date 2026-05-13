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
	AkashaGatewayCommandMenuItem,
	AkashaGatewayConfig,
	AkashaGatewayIncomingMessage,
	AkashaGatewayMessageHandler,
	AkashaGatewayPlatformAdapter,
} from "./types.js";

export const AKASHA_TELEGRAM_MENU_COMMANDS: AkashaGatewayCommandMenuItem[] = [
	{ command: "new", description: "Start a new Akasha session" },
	{ command: "model", description: "View or switch the model" },
	{ command: "thinking", description: "View or switch thinking level" },
	{ command: "stop", description: "Stop the active run" },
	{ command: "timeline", description: "Show recent Akasha time events" },
];

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
		await this.registerCommandMenu();
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
			`- callback mode: ${this.options.config.callbackMode}`,
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
		if (command.name === "model") {
			await this.adapter.sendMessage({
				chatId: chat.chatId,
				text: await this.handleModelCommand(chat, command.args),
			});
			return;
		}
		if (command.name === "thinking") {
			await this.adapter.sendMessage({
				chatId: chat.chatId,
				text: await this.handleThinkingCommand(chat, command.args),
			});
			return;
		}
		if (command.name === "timeline") {
			await this.adapter.sendMessage({ chatId: chat.chatId, text: this.handleTimelineCommand(chat, command.args) });
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

	private async registerCommandMenu(): Promise<void> {
		if (!this.adapter.setCommands) return;
		try {
			await this.adapter.setCommands(AKASHA_TELEGRAM_MENU_COMMANDS);
		} catch (error) {
			this.logger.warn(`Telegram command menu registration failed: ${errorMessage(error)}`);
		}
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
				dispatchMode: callbackDispatchModeForGateway(this.options.config.callbackMode),
				agentDir: this.options.config.agentDir,
				rules: rulesForAkashaPolicyProfile(this.options.settings.policyProfile),
			});
			for (const event of result.dispatched) {
				const summary = typeof event.payload.summary === "string" ? event.payload.summary : event.eventId;
				const safeForAutoRun = event.payload.safeForAutoRun === true;
				const autoRun = this.options.config.callbackMode === "auto_run_safe" && safeForAutoRun;
				await this.adapter.sendMessage({
					chatId: String(homeChatId),
					text: formatGatewayCallbackDeliveryText(this.options.config.callbackMode, summary, safeForAutoRun),
				});
				const autoRunResult = autoRun ? await this.runGatewayCallbackAgent(homeChatId, event, summary) : undefined;
				this.events.appendGateway("telegram", {
					kind: "gateway.callback.delivered",
					subjectId: "akasha.gateway",
					objectId: String(homeChatId),
					sourceKey: `gateway-callback-delivered:${event.eventId}`,
					parentEventIds: autoRunResult?.eventIds?.length
						? [event.eventId, ...autoRunResult.eventIds]
						: [event.eventId],
					payload: {
						chatId: String(homeChatId),
						dispatchEventId: event.eventId,
						callbackId: event.payload.callbackId,
						summary,
						callbackMode: this.options.config.callbackMode,
						safeForAutoRun,
						autoRunAttempted: autoRun,
						autoRunSessionId: autoRunResult?.sessionId,
						autoRunTextLength: autoRunResult?.textLength,
					},
					ttlPolicy: "long_term",
					importance: 0.8,
				});
			}
		}
	}

	private async runGatewayCallbackAgent(
		homeChatId: number,
		dispatchEvent: AkashaEvent,
		summary: string,
	): Promise<{ sessionId: string; textLength: number; eventIds: string[] } | undefined> {
		const chatId = String(homeChatId);
		const chat = this.sessionStore.getChat("telegram", chatId, this.options.config.defaultCwd);
		const messageId = `callback:${dispatchEvent.eventId}`;
		const prompt = formatGatewayCallbackAgentPrompt(dispatchEvent, summary);
		try {
			const stopTypingIndicator = this.startTypingIndicator(chatId);
			try {
				const result = await this.agentRunner.run({
					chat,
					message: {
						platform: "telegram",
						chatId,
						messageId,
						userId: homeChatId,
						text: prompt,
						receivedTime: new Date().toISOString(),
						raw: {
							source: "akasha.gateway.callback",
							dispatchEventId: dispatchEvent.eventId,
							callbackId: dispatchEvent.payload.callbackId,
						},
					},
				});
				await this.deliverAgentReply(chat, result.text);
				const replyEvent = this.events.appendForChat(chat, {
					kind: "gateway.reply.sent",
					subjectId: "akasha.gateway",
					objectId: result.sessionId,
					sourceKey: `gateway-callback-auto-run-reply:${dispatchEvent.eventId}:${result.sessionId}`,
					parentEventIds: [dispatchEvent.eventId],
					payload: {
						messageId,
						sessionId: result.sessionId,
						sessionFile: result.sessionFile,
						textLength: result.text.length,
						callbackId: dispatchEvent.payload.callbackId,
						dispatchEventId: dispatchEvent.eventId,
					},
					ttlPolicy: "long_term",
					importance: 0.75,
				});
				return {
					sessionId: result.sessionId,
					textLength: result.text.length,
					eventIds: [replyEvent.eventId],
				};
			} finally {
				stopTypingIndicator();
			}
		} catch (error) {
			const failedEvent = this.events.appendForChat(chat, {
				kind: "gateway.delivery.failed",
				subjectId: "akasha.gateway",
				objectId: messageId,
				sourceKey: `gateway-callback-auto-run-failed:${dispatchEvent.eventId}`,
				parentEventIds: [dispatchEvent.eventId],
				payload: {
					reason: errorMessage(error),
					messageId,
					callbackId: dispatchEvent.payload.callbackId,
					dispatchEventId: dispatchEvent.eventId,
				},
				ttlPolicy: "long_term",
				importance: 0.9,
			});
			await this.adapter.sendMessage({ chatId, text: `Akasha callback auto-run failed: ${errorMessage(error)}` });
			return {
				sessionId: "",
				textLength: 0,
				eventIds: [failedEvent.eventId],
			};
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
	return mode === "notify_only" ? "record_only" : "agent_prompt_file";
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
