import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/akasha-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAkashaClaimLedger,
	createAkashaCollectorExtension,
	resolveAkashaEventLogPath,
} from "../src/core/akasha/index.js";
import type { AkashaEvent } from "../src/core/akasha/types.js";
import type {
	ContextEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	ToolCallEvent,
	ToolDefinition,
	ToolResultEvent,
} from "../src/core/extensions/types.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("Akasha collector extension", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let sessionManager: SessionManager;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "akasha-extension-"));
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		sessionManager = SessionManager.inMemory(cwd);
	});

	afterEach(() => {
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("records a fake session/tool lifecycle and serves commands", async () => {
		const extension = createFakeExtension();
		await createAkashaCollectorExtension({
			agentDir,
			settings: SettingsManager.inMemory({
				akasha: {
					enabled: true,
					injectTemporalBrief: true,
					maxBriefEvents: 8,
					actionGate: {
						enabled: true,
					},
				},
			}).getAkashaSettings(),
		})(extension.akasha);
		const ctx = fakeContext(cwd, sessionManager);

		await extension.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await extension.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
		await extension.emit(
			"message_end",
			{
				type: "message_end",
				message: {
					role: "user",
					content: [{ type: "text", text: "Read src/app.ts" }],
					timestamp: Date.now(),
				},
			},
			ctx,
		);
		await extension.emit(
			"message_end",
			{
				type: "message_end",
				message: assistantMessageWithToolCall("call-1"),
			},
			ctx,
		);
		await extension.emit(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "call-1",
				toolName: "read",
				input: { path: "src/app.ts" },
			} satisfies ToolCallEvent,
			ctx,
		);
		await extension.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "call-1",
				toolName: "read",
				input: { path: "src/app.ts" },
				content: [{ type: "text", text: "const value = 1;" }],
				isError: false,
				details: {},
			} satisfies ToolResultEvent,
			ctx,
		);
		await extension.emit(
			"message_end",
			{
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "const value = 1;" }],
					isError: false,
					details: {},
					timestamp: Date.now(),
				},
			},
			ctx,
		);

		const contextResult = (await extension.emit(
			"context",
			{
				type: "context",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "What did we just read?" }],
						timestamp: Date.now(),
					},
				],
			},
			ctx,
		)) as ContextEventResult | undefined;
		const messages = contextResult?.messages ?? [];
		const brief = messages.find(
			(message) => message.role === "custom" && message.customType === "akasha.temporal_brief",
		);
		const gate = messages.find((message) => message.role === "custom" && message.customType === "akasha.action_gate");
		expect(customMessageContent(gate)).toContain("Temporal control facts");
		expect(customMessageContent(brief)).toContain("src/app.ts");

		const syscallTool = extension.tools.get("akasha_create_commitment");
		expect(syscallTool).toBeDefined();
		await syscallTool?.execute(
			"call-akasha-commitment",
			{
				summary: "Validate explicit Akasha syscall tools",
				dueTime: "2026-05-12T00:00:00.000Z",
				resolutionCriteria: "tool execution appends a promise.created event",
			},
			undefined,
			undefined,
			ctx,
		);
		const claimTool = extension.tools.get("akasha_record_claim");
		expect(claimTool).toBeDefined();
		await claimTool?.execute(
			"call-akasha-claim-beijing",
			{
				subject: "user",
				predicate: "work base",
				value: "Beijing",
				scope: "employment",
				exclusive: true,
			},
			undefined,
			undefined,
			ctx,
		);
		await claimTool?.execute(
			"call-akasha-claim-beijing-confirm",
			{
				subject: "user",
				predicate: "work base",
				value: "Beijing",
				scope: "employment",
				exclusive: true,
			},
			undefined,
			undefined,
			ctx,
		);
		await claimTool?.execute(
			"call-akasha-claim-shanghai",
			{
				subject: "user",
				predicate: "work base",
				value: "Shanghai",
				scope: "employment",
				exclusive: true,
			},
			undefined,
			undefined,
			ctx,
		);

		const logPath = resolveAkashaEventLogPath({}, agentDir, sessionManager.getSessionId());
		const lines = readFileSync(logPath, "utf-8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line) as AkashaEvent);
		expect(lines.map((line) => line.kind)).toEqual(
			expect.arrayContaining([
				"session.started",
				"turn.started",
				"message.user.submitted",
				"message.agent.completed",
				"promise.created",
				"prediction.made",
				"policy.evaluated",
				"action_surface.requested",
				"action_surface.completed",
				"tool.requested",
				"tool.completed",
				"artifact.read",
				"message.tool_result.recorded",
				"action_gate.injected",
				"claim.observed",
				"claim.confirmed",
				"claim.superseded",
			]),
		);
		expect(
			lines.some((line) => line.kind === "promise.created" && line.toolCallId === "call-akasha-commitment"),
		).toBe(true);
		const completed = lines.find((line) => line.kind === "tool.completed" && line.toolCallId === "call-1");
		const surfaceRequested = lines.find((line) => line.kind === "action_surface.requested");
		const surfaceCompleted = lines.find((line) => line.kind === "action_surface.completed");
		const resultMessage = lines.find((line) => line.kind === "message.tool_result.recorded");
		expect(completed).toBeDefined();
		expect(surfaceRequested).toBeDefined();
		expect(surfaceCompleted?.parentEventIds).toContain(surfaceRequested?.eventId);
		expect(resultMessage).toBeDefined();
		expect(resultMessage?.parentEventIds).toContain(completed?.eventId);
		const claimLedger = buildAkashaClaimLedger(lines);
		expect(claimLedger.current[0]).toMatchObject({ value: "Shanghai" });
		expect(claimLedger.historical[0]).toMatchObject({ value: "Beijing" });

		const notices: string[] = [];
		const command = extension.commands.get("akasha");
		expect(command).toBeDefined();
		await command?.handler("timeline 20", fakeCommandContext(notices));
		await command?.handler("why call-1", fakeCommandContext(notices));
		await command?.handler("explain-current", fakeCommandContext(notices));
		await command?.handler("open-loops", fakeCommandContext(notices));
		await command?.handler("project-state", fakeCommandContext(notices));
		await command?.handler("user-timeline", fakeCommandContext(notices));
		await command?.handler("action-gate", fakeCommandContext(notices));
		await command?.handler("queue", fakeCommandContext(notices));
		await command?.handler("callback-complete callback-test", fakeCommandContext(notices));
		await command?.handler("callback-cancel callback-test obsolete", fakeCommandContext(notices));
		await command?.handler("task-model", fakeCommandContext(notices));
		await command?.handler("karma", fakeCommandContext(notices));
		await command?.handler("governance", fakeCommandContext(notices));
		await command?.handler("doctor", fakeCommandContext(notices));
		expect(notices.join("\n")).toContain("tool.completed");
		expect(notices.join("\n")).toContain("artifact.read");
		expect(notices.join("\n")).toContain("Current intent");
		expect(notices.join("\n")).toContain("Open loops");
		expect(notices.join("\n")).toContain("Current goal");
		expect(notices.join("\n")).toContain("User timeline:");
		expect(notices.join("\n")).toContain("<akasha_action_gate>");
		expect(notices.join("\n")).toContain("Akasha daemon queue:");
		expect(notices.join("\n")).toContain("Callback completed:");
		expect(notices.join("\n")).toContain("Callback cancelled:");
		expect(notices.join("\n")).toContain("Task model:");
		expect(notices.join("\n")).toContain("Karma:");
		expect(notices.join("\n")).toContain("Governance:");
		expect(notices.join("\n")).toContain("Akasha doctor:");
	});

	it("keeps Akasha disabled by default", () => {
		const settings = SettingsManager.inMemory();

		expect(settings.getAkashaSettings()).toEqual({
			enabled: false,
			injectTemporalBrief: false,
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
				enabled: false,
				includeProjectState: true,
				includeUserTimeline: true,
				maxItems: 8,
				enforceToolGate: false,
				blockDestructiveCommands: true,
				blockUnverifiedArtifactWrites: false,
			},
			reflection: {
				enabled: false,
				minEventsSinceLastReflection: 40,
				minIntervalMinutes: 240,
			},
			maintenance: {
				enabled: false,
				runOnTurnEnd: false,
				heartbeatEnabled: false,
				heartbeatIntervalMinutes: 30,
				runOnSessionStart: false,
			},
			privacy: {
				redactSecrets: true,
			},
			temporalProtocol: {
				syscallAuditMode: "soft",
			},
			gateway: {
				enabled: false,
				defaultCwd: undefined,
				callbackMode: "notify_only",
				platforms: {
					telegram: {
						enabled: false,
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
		});
	});

	it("does not duplicate heuristic promises when assistant uses explicit Akasha syscalls", async () => {
		const extension = createFakeExtension();
		await createAkashaCollectorExtension({
			agentDir,
			settings: SettingsManager.inMemory({
				akasha: {
					enabled: true,
				},
			}).getAkashaSettings(),
		})(extension.akasha);
		const ctx = fakeContext(cwd, sessionManager);

		await extension.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await extension.emit(
			"message_end",
			{
				type: "message_end",
				message: assistantMessageWithToolCall("call-akasha", "akasha_create_commitment"),
			},
			ctx,
		);

		const logPath = resolveAkashaEventLogPath({}, agentDir, sessionManager.getSessionId());
		const contents = readFileSync(logPath, "utf-8");
		expect(contents).toContain('"kind":"message.agent.completed"');
		expect(contents).not.toContain('"kind":"promise.created"');
	});

	it("injects a strict syscall repair prompt and records the injection event", async () => {
		const extension = createFakeExtension();
		await createAkashaCollectorExtension({
			agentDir,
			settings: SettingsManager.inMemory({
				akasha: {
					enabled: true,
					temporalProtocol: {
						syscallAuditMode: "strict",
					},
				},
			}).getAkashaSettings(),
		})(extension.akasha);
		const ctx = fakeContext(cwd, sessionManager);

		await extension.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await extension.emit(
			"message_end",
			{
				type: "message_end",
				message: assistantTextMessage("I will check this again tomorrow."),
			},
			ctx,
		);

		const contextResult = (await extension.emit(
			"context",
			{
				type: "context",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Continue" }],
						timestamp: Date.now(),
					},
				],
			},
			ctx,
		)) as ContextEventResult | undefined;

		const repair = contextResult?.messages?.find(
			(message) => message.role === "custom" && message.customType === "akasha.syscall_repair",
		);
		expect(customMessageContent(repair)).toContain("Strict temporal protocol is active");
		expect(customMessageContent(repair)).toContain("akasha_create_commitment");
		const logPath = resolveAkashaEventLogPath({}, agentDir, sessionManager.getSessionId());
		const contents = readFileSync(logPath, "utf-8");
		expect(contents).toContain('"kind":"time_syscall.missing"');
		expect(contents).toContain('"kind":"time_syscall.repair_prompt.injected"');
	});

	it("blocks dangerous tool calls when hard tool gate is enabled", async () => {
		const extension = createFakeExtension();
		await createAkashaCollectorExtension({
			agentDir,
			settings: SettingsManager.inMemory({
				akasha: {
					enabled: true,
					actionGate: {
						enforceToolGate: true,
					},
				},
			}).getAkashaSettings(),
		})(extension.akasha);
		const ctx = fakeContext(cwd, sessionManager);

		await extension.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const result = (await extension.emit(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "call-danger",
				toolName: "bash",
				input: { command: "git reset --hard HEAD" },
			} satisfies ToolCallEvent,
			ctx,
		)) as { block?: boolean; reason?: string } | undefined;

		expect(result).toMatchObject({ block: true });
		expect(result?.reason).toContain("high-risk command");

		const logPath = resolveAkashaEventLogPath({}, agentDir, sessionManager.getSessionId());
		const contents = readFileSync(logPath, "utf-8");
		expect(contents).toContain('"kind":"policy.evaluated"');
		expect(contents).toContain('"kind":"action_surface.requested"');
		expect(contents).toContain('"kind":"action_surface.failed"');
		expect(contents).toContain('"kind":"tool.blocked"');
	});

	it("closes HML recall feedback through real context, tool call, and tool result hooks", async () => {
		const extension = createFakeExtension();
		await createAkashaCollectorExtension({
			agentDir,
			settings: SettingsManager.inMemory({
				akasha: {
					enabled: true,
					actionGate: {
						enabled: true,
						includeProjectState: false,
						includeUserTimeline: false,
					},
					holographicMemory: {
						enabled: true,
						injectIntoActionGate: true,
						recordRecallEvents: true,
					},
				},
			}).getAkashaSettings(),
		})(extension.akasha);
		const ctx = fakeContext(cwd, sessionManager);

		await extension.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await extension.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
		await extension.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "call-failed",
				toolName: "bash",
				input: { command: "npm test" },
				content: [{ type: "text", text: "npm test failed because cwd was wrong" }],
				isError: true,
				details: {},
			} satisfies ToolResultEvent,
			ctx,
		);

		const contextResult = (await extension.emit(
			"context",
			{
				type: "context",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Retry the failed npm test from the correct cwd" }],
						timestamp: Date.now(),
					},
				],
			},
			ctx,
		)) as ContextEventResult | undefined;
		expect(
			contextResult?.messages?.some(
				(message) => message.role === "custom" && message.customType === "akasha.action_gate",
			),
		).toBe(true);

		await extension.emit(
			"tool_call",
			{
				type: "tool_call",
				toolCallId: "call-success",
				toolName: "bash",
				input: { command: "npm test" },
			} satisfies ToolCallEvent,
			ctx,
		);
		await extension.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "call-success",
				toolName: "bash",
				input: { command: "npm test" },
				content: [{ type: "text", text: "npm test passed" }],
				isError: false,
				details: {},
			} satisfies ToolResultEvent,
			ctx,
		);

		const lines = readLog(agentDir, sessionManager.getSessionId());
		expect(lines.map((line) => line.kind)).toEqual(
			expect.arrayContaining(["memory.recalled", "memory.applied", "memory.reinforced"]),
		);
		const applied = lines.find((line) => line.kind === "memory.applied" && line.toolCallId === "call-success");
		const reinforced = lines.find((line) => line.kind === "memory.reinforced" && line.toolCallId === "call-success");
		expect(applied?.payload.recallEventId).toEqual(expect.any(String));
		expect(reinforced?.payload.appliedEventId).toBe(applied?.eventId);
	});
});

function assistantTextMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function assistantMessageWithToolCall(toolCallId: string, toolName = "read"): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "I will inspect the file. The read should work." },
			{ type: "toolCall", id: toolCallId, name: toolName, arguments: { path: "src/app.ts" } },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function fakeCommandContext(notices: string[]): ExtensionCommandContext {
	return {
		cwd: process.cwd(),
		ui: {
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionCommandContext;
}

function fakeContext(cwd: string, sessionManager: SessionManager): ExtensionContext {
	return {
		cwd,
		sessionManager,
		ui: {
			notify: () => {},
		},
	} as unknown as ExtensionContext;
}

function customMessageContent(message: AgentMessage | undefined): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = message.content;
	return typeof content === "string" ? content : JSON.stringify(content);
}

function readLog(
	agentDir: string,
	sessionId: string,
): Array<{
	eventId: string;
	kind: string;
	toolCallId?: string;
	parentEventIds: string[];
	payload: Record<string, unknown>;
}> {
	return readFileSync(resolveAkashaEventLogPath({}, agentDir, sessionId), "utf-8")
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function createFakeExtension(): {
	akasha: ExtensionAPI;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	tools: Map<string, ToolDefinition>;
	emit: (eventType: string, event: unknown, ctx: ExtensionContext) => Promise<unknown>;
} {
	const handlers = new Map<string, ExtensionHandler<unknown, unknown>[]>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const tools = new Map<string, ToolDefinition>();
	const akasha = {
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		registerTool(tool: ToolDefinition): void {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			commands.set(name, options);
		},
	} as ExtensionAPI;

	return {
		akasha,
		commands,
		tools,
		emit: async (eventType, event, ctx) => {
			let result: unknown;
			for (const handler of handlers.get(eventType) ?? []) {
				const next = await handler(event, ctx);
				if (next !== undefined) result = next;
			}
			return result;
		},
	};
}
