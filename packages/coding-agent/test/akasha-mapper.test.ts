import type { AgentMessage } from "@earendil-works/akasha-agent-core";
import { describe, expect, it } from "vitest";
import { mapMessageEnd, mapToolCompleted, mapToolOutcome, mapToolRequested } from "../src/core/akasha/mapper.js";
import type { AkashaEventDraft } from "../src/core/akasha/types.js";
import type { ToolCallEvent, ToolResultEvent } from "../src/core/extensions/types.js";

describe("Akasha mapper", () => {
	const context = {
		sessionId: "session-1",
		streamId: "session:session-1",
		eventTime: "2026-05-11T00:00:00.000Z",
		sourceKey: "source",
	};

	it("maps user to assistant to tool to artifact to tool-result semantics", () => {
		const userMessage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Please patch src/app.ts" }],
			timestamp: Date.parse(context.eventTime),
		};
		const assistantMessage: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "src/app.ts" } }],
			provider: "test",
			model: "test-model",
			api: "openai-responses",
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.parse(context.eventTime),
		};
		const toolCall = {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "edit",
			input: {
				path: "src/app.ts",
				edits: [{ oldText: "before", newText: "after" }],
			},
		} satisfies ToolCallEvent;
		const toolResult = {
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "edit",
			input: toolCall.input,
			content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/app.ts." }],
			isError: false,
			details: { diff: "-before\n+after", firstChangedLine: 7 },
		} satisfies ToolResultEvent;
		const toolResultMessage: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "edit",
			content: toolResult.content,
			isError: false,
			details: toolResult.details,
			timestamp: Date.parse(context.eventTime),
		};

		const user = mapMessageEnd(userMessage, context) as AkashaEventDraft;
		const assistant = mapMessageEnd(assistantMessage, {
			...context,
			parentEventIds: ["user-event"],
			sourceKey: "assistant",
		}) as AkashaEventDraft;
		const requested = mapToolRequested(toolCall, {
			...context,
			parentEventIds: ["assistant-event"],
			sourceKey: "tool-request",
		});
		const completed = mapToolCompleted(toolResult, {
			...context,
			parentEventIds: ["tool-request-event"],
			sourceKey: "tool-complete",
		});
		const artifact = mapToolOutcome(toolResult, {
			...context,
			parentEventIds: ["tool-complete-event"],
			sourceKey: "tool-outcome",
		}) as AkashaEventDraft;
		const resultMessage = mapMessageEnd(toolResultMessage, {
			...context,
			parentEventIds: ["tool-complete-event"],
			sourceKey: "tool-result-message",
		}) as AkashaEventDraft;

		expect(user.kind).toBe("message.user.submitted");
		expect(String(user.payload?.text)).toContain("Please patch");
		expect(assistant.kind).toBe("message.agent.completed");
		expect(assistant.payload?.toolCallIds).toEqual(["call-1"]);
		expect(requested.kind).toBe("tool.requested");
		expect(requested.payload?.input).toEqual({
			path: "src/app.ts",
			editCount: 1,
			edits: [{ oldTextLength: 6, newTextLength: 5 }],
		});
		expect(completed.kind).toBe("tool.completed");
		expect(artifact.kind).toBe("artifact.patched");
		expect(artifact.objectId).toBe("src/app.ts");
		expect(resultMessage.kind).toBe("message.tool_result.recorded");
	});
});
