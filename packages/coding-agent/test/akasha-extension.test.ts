import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAkashaCollectorExtension, resolveAkashaEventLogPath } from "../src/core/akasha/index.js";
import type {
	ContextEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionHandler,
	RegisteredCommand,
	ToolCallEvent,
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
		})(extension.pi);
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

		const logPath = resolveAkashaEventLogPath({}, agentDir, sessionManager.getSessionId());
		const lines = readFileSync(logPath, "utf-8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as {
						eventId: string;
						kind: string;
						toolCallId?: string;
						parentEventIds: string[];
					},
			);
		expect(lines.map((line) => line.kind)).toEqual(
			expect.arrayContaining([
				"session.started",
				"turn.started",
				"message.user.submitted",
				"message.agent.completed",
				"promise.created",
				"prediction.made",
				"tool.requested",
				"tool.completed",
				"artifact.read",
				"message.tool_result.recorded",
			]),
		);
		const completed = lines.find((line) => line.kind === "tool.completed" && line.toolCallId === "call-1");
		const resultMessage = lines.find((line) => line.kind === "message.tool_result.recorded");
		expect(completed).toBeDefined();
		expect(resultMessage).toBeDefined();
		expect(resultMessage?.parentEventIds).toContain(completed?.eventId);

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
		});
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
		})(extension.pi);
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
		expect(contents).toContain('"kind":"tool.blocked"');
	});
});

function assistantMessageWithToolCall(toolCallId: string): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "I will inspect the file. The read should work." },
			{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/app.ts" } },
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

function createFakeExtension(): {
	pi: ExtensionAPI;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	emit: (eventType: string, event: unknown, ctx: ExtensionContext) => Promise<unknown>;
} {
	const handlers = new Map<string, ExtensionHandler<unknown, unknown>[]>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const pi = {
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			commands.set(name, options);
		},
	} as ExtensionAPI;

	return {
		pi,
		commands,
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
