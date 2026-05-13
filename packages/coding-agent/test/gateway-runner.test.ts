import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlAkashaStore } from "../src/core/akasha/jsonl-store.js";
import type { AkashaGatewayCallbackMode, ResolvedAkashaSettings } from "../src/core/settings-manager.js";
import { AkashaGatewayLogger } from "../src/gateway/logger.js";
import { AkashaGatewayRunner } from "../src/gateway/runner.js";
import type {
	AkashaGatewayAgentResult,
	AkashaGatewayAgentRunInput,
	AkashaGatewayAgentRunner,
	AkashaGatewayConfig,
	AkashaGatewayOutgoingMessage,
	AkashaGatewayPlatformAdapter,
} from "../src/gateway/types.js";

describe("AkashaGatewayRunner", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-gateway-runner-"));
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers the compact Telegram native command menu on startup", async () => {
		const adapter = new FakeAdapter();
		const runner = createRunner({ adapter });

		await runner.start();

		expect(adapter.commands.map((command) => command.command)).toEqual([
			"new",
			"model",
			"thinking",
			"stop",
			"timeline",
		]);
	});

	it("rejects Telegram users outside the allowlist and writes a gateway event", async () => {
		const adapter = new FakeAdapter();
		const runner = createRunner({ adapter, allowedUsers: new Set([123]) });

		await runner.handle({
			platform: "telegram",
			chatId: "1",
			messageId: "10",
			userId: 999,
			text: "hello",
			receivedTime: "2026-05-12T00:00:00.000Z",
		});

		expect(adapter.sent.at(-1)?.text).toContain("not configured");
		expect(readGatewayEvents()).toContain("gateway.message.rejected");
	});

	it("runs allowed messages through the agent and sends the response", async () => {
		const adapter = new FakeAdapter();
		const agent = new FakeAgentRunner("Agent reply");
		const runner = createRunner({ adapter, agentRunner: agent });

		await runner.handle({
			platform: "telegram",
			chatId: "1",
			messageId: "11",
			userId: 123,
			text: "do work",
			receivedTime: "2026-05-12T00:00:00.000Z",
		});
		await waitFor(() => adapter.sent.some((message) => message.text === "Agent reply"));

		expect(agent.runs[0].message.text).toBe("do work");
		expect(adapter.sent.map((message) => message.text)).not.toContain("Akasha is thinking...");
		expect(adapter.chatActions).toEqual([{ chatId: "1", action: "typing" }]);
		expect(readGatewayEvents()).toContain("gateway.message.accepted");
		expect(readGatewayEvents()).toContain("gateway.reply.sent");
	});

	it("handles /setcwd and /stop commands without invoking the agent queue", async () => {
		const adapter = new FakeAdapter();
		const agent = new FakeAgentRunner("unused");
		agent.stopResult = true;
		const runner = createRunner({ adapter, agentRunner: agent });

		await runner.handle({
			platform: "telegram",
			chatId: "1",
			messageId: "12",
			userId: 123,
			text: `/setcwd ${projectDir}`,
			receivedTime: "2026-05-12T00:00:00.000Z",
		});
		await runner.handle({
			platform: "telegram",
			chatId: "1",
			messageId: "13",
			userId: 123,
			text: "/stop",
			receivedTime: "2026-05-12T00:00:00.000Z",
		});

		expect(adapter.sent.map((message) => message.text).join("\n")).toContain(`cwd set to ${projectDir}`);
		expect(adapter.sent.map((message) => message.text).join("\n")).toContain("Stopped the active Akasha run");
		expect(agent.stopCalls).toEqual(["1"]);
		expect(agent.runs).toHaveLength(0);
		expect(readGatewayEvents()).toContain("gateway.command.executed");
	});

	it("handles Telegram menu commands for thinking, model, and timeline", async () => {
		const adapter = new FakeAdapter();
		const runner = createRunner({ adapter });

		await runner.handle({
			platform: "telegram",
			chatId: "1",
			messageId: "14",
			userId: 123,
			text: "/thinking high",
			receivedTime: "2026-05-12T00:00:00.000Z",
		});
		await runner.handle({
			platform: "telegram",
			chatId: "1",
			messageId: "15",
			userId: 123,
			text: "/model",
			receivedTime: "2026-05-12T00:00:01.000Z",
		});
		await runner.handle({
			platform: "telegram",
			chatId: "1",
			messageId: "16",
			userId: 123,
			text: "/timeline 5",
			receivedTime: "2026-05-12T00:00:02.000Z",
		});

		const sent = adapter.sent.map((message) => message.text).join("\n---\n");
		expect(sent).toContain("Thinking level switched to high");
		expect(sent).toContain("Current model:");
		expect(sent).toContain("Akasha timeline:");
		expect(readGatewayEvents()).toContain("gateway.command.executed");
	});

	it("keeps notify_only callback delivery as a notification-only default", async () => {
		appendDueCallback("callback-notify", "Notify only callback", "promise_due");
		const adapter = new FakeAdapter();
		const agent = new FakeAgentRunner("unused");
		const runner = createRunner({ adapter, agentRunner: agent });

		await runner.start();

		expect(adapter.sent.map((message) => message.text).join("\n")).toContain("Akasha callback due");
		expect(agent.runs).toHaveLength(0);
		expect(readInbox()).toBe("");
		expect(readGatewayEvents()).toContain('"callbackMode":"notify_only"');
	});

	it("queues due callbacks into the Akasha inbox when callback mode is inbox_only", async () => {
		appendDueCallback("callback-1", "Review inbox callback", "promise_due");
		const adapter = new FakeAdapter();
		const agent = new FakeAgentRunner("unused");
		const runner = createRunner({ adapter, agentRunner: agent, callbackMode: "inbox_only" });

		await runner.start();

		expect(adapter.sent.map((message) => message.text).join("\n")).toContain("queued in inbox");
		expect(agent.runs).toHaveLength(0);
		expect(readInbox()).toContain("Review inbox callback");
		expect(readGatewayEvents()).toContain("gateway.callback.delivered");
		expect(readGatewayEvents()).toContain('"callbackMode":"inbox_only"');
	});

	it("auto-runs safe due callbacks and records the gateway reply", async () => {
		appendDueCallback("callback-2", "Check a due prediction", "prediction_due");
		const adapter = new FakeAdapter();
		const agent = new FakeAgentRunner("Auto-run reply");
		const runner = createRunner({ adapter, agentRunner: agent, callbackMode: "auto_run_safe" });

		await runner.start();

		expect(adapter.sent.map((message) => message.text).join("\n")).toContain("safe for auto-run");
		expect(adapter.sent.map((message) => message.text)).toContain("Auto-run reply");
		expect(agent.runs[0].message.text).toContain("callbackId: callback-2");
		expect(readGatewayEvents()).toContain('"autoRunAttempted":true');
		expect(readGatewayEvents()).toContain("gateway.reply.sent");
	});

	function createRunner(options: {
		adapter: FakeAdapter;
		agentRunner?: AkashaGatewayAgentRunner;
		allowedUsers?: Set<number>;
		callbackMode?: AkashaGatewayCallbackMode;
	}): AkashaGatewayRunner {
		return new AkashaGatewayRunner({
			config: createConfig(options.allowedUsers ?? new Set([123]), options.callbackMode ?? "notify_only"),
			settings: createSettings(options.callbackMode ?? "notify_only"),
			adapter: options.adapter,
			agentRunner: options.agentRunner ?? new FakeAgentRunner("ok"),
			logger: new AkashaGatewayLogger(agentDir, true),
		});
	}

	function createConfig(allowedUsers: Set<number>, callbackMode: AkashaGatewayCallbackMode): AkashaGatewayConfig {
		return {
			enabled: true,
			agentDir,
			defaultCwd: projectDir,
			callbackMode,
			telegram: {
				enabled: true,
				mode: "polling",
				botToken: "secret",
				allowedUsers,
				homeChatId: 123,
				webhookPort: 8443,
			},
		};
	}

	function createSettings(callbackMode: AkashaGatewayCallbackMode = "notify_only"): ResolvedAkashaSettings {
		return {
			enabled: true,
			injectTemporalBrief: true,
			maxBriefEvents: 12,
			eventLogDir: undefined,
			embedding: {
				enabled: false,
				provider: "off",
				model: "text-embedding-3-small",
				baseUrl: "https://api.openai.com/v1/embeddings",
				apiKeyEnv: "OPENAI_API_KEY",
				indexDir: undefined,
				dimensions: 64,
			},
			actionGate: {
				enabled: true,
				includeProjectState: true,
				includeUserTimeline: true,
				maxItems: 8,
				enforceToolGate: true,
				blockDestructiveCommands: true,
				blockUnverifiedArtifactWrites: false,
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
			privacy: { redactSecrets: true },
			temporalProtocol: { syscallAuditMode: "soft" },
			holographicMemory: {
				enabled: false,
				injectIntoActionGate: false,
				recordRecallEvents: true,
				maxTraces: 24,
				maxEpisodes: 3,
				maxLessons: 3,
				maxProcedures: 2,
				maxWarnings: 3,
			},
			policyProfile: "dogfood",
			gateway: {
				enabled: true,
				defaultCwd: projectDir,
				callbackMode,
				platforms: {
					telegram: {
						enabled: true,
						mode: "polling",
						botTokenEnv: "TELEGRAM_BOT_TOKEN",
						allowedUsersEnv: "TELEGRAM_ALLOWED_USERS",
						homeChatEnv: "TELEGRAM_HOME_CHAT",
						webhookUrlEnv: "TELEGRAM_WEBHOOK_URL",
						webhookSecretEnv: "TELEGRAM_WEBHOOK_SECRET",
						webhookPortEnv: "TELEGRAM_WEBHOOK_PORT",
					},
				},
			},
		};
	}

	function appendDueCallback(callbackId: string, summary: string, kind: string): void {
		const store = new JsonlAkashaStore(join(agentDir, "akasha", "events", "session-1.jsonl"));
		const session = store.append({
			kind: "session.started",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:00:00.000Z",
			actor: "system",
			sourceKey: "session-started:session-1",
			payload: { cwd: projectDir },
			ttlPolicy: "long_term",
			importance: 0.5,
		});
		store.append({
			kind: "time.callback.due",
			sessionId: "session-1",
			streamId: "session:session-1",
			eventTime: "2026-05-12T00:01:00.000Z",
			actor: "system",
			subjectId: "akasha.daemon",
			objectId: "promise-1",
			sourceKey: `callback-due:${callbackId}`,
			parentEventIds: [session.eventId],
			payload: {
				callbackId,
				kind,
				summary,
				targetEventId: "promise-1",
			},
			ttlPolicy: "long_term",
			importance: 0.8,
		});
	}

	function readInbox(): string {
		const path = join(agentDir, "akasha", "inbox", "pending-callbacks.jsonl");
		return existsSync(path) ? readFileSync(path, "utf-8") : "";
	}

	function readGatewayEvents(): string {
		const dir = join(agentDir, "akasha", "events");
		if (!existsSync(dir)) return "";
		return readdirSync(dir)
			.map((file) => readFileSync(join(dir, file), "utf-8"))
			.join("\n");
	}
});

class FakeAdapter implements AkashaGatewayPlatformAdapter {
	readonly name = "telegram" as const;
	readonly sent: AkashaGatewayOutgoingMessage[] = [];
	readonly chatActions: Array<{ chatId: string; action: "typing" }> = [];
	readonly commands: Array<{ command: string; description: string }> = [];

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async sendMessage(message: AkashaGatewayOutgoingMessage): Promise<void> {
		this.sent.push(message);
	}
	async sendChatAction(chatId: string, action: "typing" = "typing"): Promise<void> {
		this.chatActions.push({ chatId, action });
	}
	async setCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
		this.commands.push(...commands);
	}
}

class FakeAgentRunner implements AkashaGatewayAgentRunner {
	readonly runs: AkashaGatewayAgentRunInput[] = [];
	readonly stopCalls: string[] = [];
	stopResult = false;

	constructor(private readonly response: string) {}

	async run(input: AkashaGatewayAgentRunInput): Promise<AkashaGatewayAgentResult> {
		this.runs.push(input);
		return { text: this.response, sessionId: "session-1", sessionFile: "/tmp/session.jsonl" };
	}

	async stop(chatId: string): Promise<boolean> {
		this.stopCalls.push(chatId);
		return this.stopResult;
	}
}

async function waitFor(assertion: () => boolean): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (assertion()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(assertion()).toBe(true);
}
