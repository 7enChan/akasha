import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedAkashaSettings } from "../src/core/settings-manager.js";
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

	function createRunner(options: {
		adapter: FakeAdapter;
		agentRunner?: AkashaGatewayAgentRunner;
		allowedUsers?: Set<number>;
	}): AkashaGatewayRunner {
		return new AkashaGatewayRunner({
			config: createConfig(options.allowedUsers ?? new Set([123])),
			settings: createSettings(),
			adapter: options.adapter,
			agentRunner: options.agentRunner ?? new FakeAgentRunner("ok"),
			logger: new AkashaGatewayLogger(agentDir, true),
		});
	}

	function createConfig(allowedUsers: Set<number>): AkashaGatewayConfig {
		return {
			enabled: true,
			agentDir,
			defaultCwd: projectDir,
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

	function createSettings(): ResolvedAkashaSettings {
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
			gateway: {
				enabled: true,
				defaultCwd: projectDir,
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
