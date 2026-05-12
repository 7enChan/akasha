import type { AgentMessage } from "@earendil-works/akasha-agent-core";
import type { ToolCallEvent, ToolResultEvent } from "../extensions/types.js";
import type { SessionEntry } from "../session-manager.js";
import type { AkashaActor, AkashaEventDraft, AkashaEventKind } from "./types.js";

const MAX_TEXT = 800;
const MAX_JSON_TEXT = 1000;

export interface AkashaMappingContext {
	sessionId: string;
	streamId: string;
	eventTime: string;
	sourceKey: string;
	parentEventIds?: string[];
	correlationId?: string;
}

export function truncateText(value: string, max = MAX_TEXT): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}... [truncated ${value.length - max} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactUnknown(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return truncateText(value, MAX_JSON_TEXT);
	if (typeof value !== "object" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactUnknown(item, depth + 1));
	if (depth >= 2) return "[object]";

	const compacted: Record<string, unknown> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		if (key === "content") {
			compacted.contentLength = typeof rawValue === "string" ? rawValue.length : undefined;
			continue;
		}
		if (key === "oldText" || key === "newText") {
			compacted[`${key}Length`] = typeof rawValue === "string" ? rawValue.length : undefined;
			continue;
		}
		if (key === "output" || key === "data") {
			compacted[`${key}Preview`] = typeof rawValue === "string" ? truncateText(rawValue, 300) : "[non-string]";
			continue;
		}
		compacted[key] = compactUnknown(rawValue, depth + 1);
	}
	return compacted;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function contentTypes(content: unknown): string[] {
	if (typeof content === "string") return ["text"];
	if (!Array.isArray(content)) return [];
	return content.map((block) => (isRecord(block) && typeof block.type === "string" ? block.type : "unknown"));
}

function imageCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter((block) => isRecord(block) && block.type === "image").length;
}

function toolCallIds(message: AgentMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content
		.filter((block) => isRecord(block) && block.type === "toolCall" && typeof block.id === "string")
		.map((block) => (block as { id: string }).id);
}

function baseDraft(
	context: AkashaMappingContext,
	kind: AkashaEventKind,
	actor: AkashaActor,
	payload: Record<string, unknown>,
): AkashaEventDraft {
	return {
		kind,
		sessionId: context.sessionId,
		streamId: context.streamId,
		eventTime: context.eventTime,
		actor,
		sourceKey: context.sourceKey,
		parentEventIds: context.parentEventIds ?? [],
		correlationId: context.correlationId,
		payload,
	};
}

export function mapMessageEnd(message: AgentMessage, context: AkashaMappingContext): AkashaEventDraft | undefined {
	if (message.role === "user") {
		return {
			...baseDraft(context, "message.user.submitted", "user", {
				text: truncateText(contentText(message.content)),
				contentTypes: contentTypes(message.content),
				imageCount: imageCount(message.content),
				timestamp: message.timestamp,
			}),
			importance: 0.75,
			ttlPolicy: "long_term",
		};
	}

	if (message.role === "assistant") {
		const ids = toolCallIds(message);
		return {
			...baseDraft(context, "message.agent.completed", "agent", {
				text: truncateText(contentText(message.content)),
				provider: message.provider,
				model: message.model,
				api: message.api,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				toolCallIds: ids,
				timestamp: message.timestamp,
			}),
			importance: ids.length > 0 || message.stopReason === "error" ? 0.85 : 0.65,
			ttlPolicy: "long_term",
		};
	}

	if (message.role === "toolResult") {
		return {
			...baseDraft(context, "message.tool_result.recorded", "tool", {
				toolName: message.toolName,
				text: truncateText(contentText(message.content)),
				isError: message.isError,
				details: compactUnknown(message.details),
				timestamp: message.timestamp,
			}),
			toolCallId: message.toolCallId,
			objectId: message.toolName,
			importance: message.isError ? 0.9 : 0.6,
			ttlPolicy: "long_term",
		};
	}

	if (message.role === "custom") {
		return {
			...baseDraft(context, "message.custom.recorded", "system", {
				customType: message.customType,
				text: truncateText(contentText(message.content)),
				display: message.display,
				details: compactUnknown(message.details),
				timestamp: message.timestamp,
			}),
			objectId: message.customType,
			importance: 0.45,
			ttlPolicy: "session",
		};
	}

	return undefined;
}

export function mapToolRequested(event: ToolCallEvent, context: AkashaMappingContext): AkashaEventDraft {
	return {
		...baseDraft(context, "tool.requested", "agent", {
			toolName: event.toolName,
			input: compactToolInput(event.toolName, event.input),
		}),
		toolCallId: event.toolCallId,
		objectId: event.toolName,
		importance: 0.7,
		ttlPolicy: "long_term",
	};
}

export function mapToolCompleted(event: ToolResultEvent, context: AkashaMappingContext): AkashaEventDraft {
	return {
		...baseDraft(context, "tool.completed", "tool", {
			toolName: event.toolName,
			isError: event.isError,
			text: truncateText(contentText(event.content), 600),
			details: compactUnknown(event.details),
		}),
		toolCallId: event.toolCallId,
		objectId: event.toolName,
		importance: event.isError ? 0.95 : 0.7,
		ttlPolicy: "long_term",
	};
}

export function mapToolOutcome(event: ToolResultEvent, context: AkashaMappingContext): AkashaEventDraft | undefined {
	const input = event.input;
	const path = readPath(input);
	if (event.toolName === "read" && path) {
		return {
			...baseDraft(context, "artifact.read", "tool", {
				path,
				offset: numberField(input, "offset"),
				limit: numberField(input, "limit"),
				isError: event.isError,
			}),
			toolCallId: event.toolCallId,
			objectId: path,
			importance: event.isError ? 0.85 : 0.55,
			ttlPolicy: "long_term",
		};
	}

	if (event.toolName === "edit" && path) {
		const details = isRecord(event.details) ? event.details : {};
		return {
			...baseDraft(context, "artifact.patched", "tool", {
				path,
				editCount: Array.isArray(input.edits) ? input.edits.length : undefined,
				isError: event.isError,
				firstChangedLine: details.firstChangedLine,
				diffPreview: typeof details.diff === "string" ? truncateText(details.diff, 1000) : undefined,
			}),
			toolCallId: event.toolCallId,
			objectId: path,
			importance: event.isError ? 0.95 : 0.9,
			ttlPolicy: "long_term",
		};
	}

	if (event.toolName === "write" && path) {
		return {
			...baseDraft(context, "artifact.written", "tool", {
				path,
				contentLength: typeof input.content === "string" ? input.content.length : undefined,
				isError: event.isError,
			}),
			toolCallId: event.toolCallId,
			objectId: path,
			importance: event.isError ? 0.95 : 0.9,
			ttlPolicy: "long_term",
		};
	}

	if (event.toolName === "bash" && typeof input.command === "string") {
		return {
			...baseDraft(context, "command.executed", "tool", {
				command: truncateText(input.command, 600),
				timeout: numberField(input, "timeout"),
				isError: event.isError,
				details: compactUnknown(event.details),
			}),
			toolCallId: event.toolCallId,
			objectId: truncateText(input.command, 120),
			importance: event.isError ? 0.9 : 0.7,
			ttlPolicy: "long_term",
		};
	}

	return undefined;
}

export function mapSessionEntry(entry: SessionEntry, context: AkashaMappingContext): AkashaEventDraft | undefined {
	if (entry.type === "model_change") {
		return {
			...baseDraft(context, "model.changed", "system", {
				provider: entry.provider,
				modelId: entry.modelId,
				sessionEntryId: entry.id,
			}),
			objectId: `${entry.provider}/${entry.modelId}`,
			importance: 0.45,
			ttlPolicy: "session",
		};
	}

	if (entry.type === "thinking_level_change") {
		return {
			...baseDraft(context, "thinking_level.changed", "system", {
				thinkingLevel: entry.thinkingLevel,
				sessionEntryId: entry.id,
			}),
			objectId: entry.thinkingLevel,
			importance: 0.4,
			ttlPolicy: "session",
		};
	}

	if (entry.type === "compaction") {
		return {
			...baseDraft(context, "context.compacted", "system", {
				summary: truncateText(entry.summary, 1000),
				firstKeptEntryId: entry.firstKeptEntryId,
				tokensBefore: entry.tokensBefore,
				fromHook: entry.fromHook,
				sessionEntryId: entry.id,
			}),
			objectId: entry.id,
			importance: 0.8,
			ttlPolicy: "long_term",
		};
	}

	if (entry.type === "branch_summary") {
		return {
			...baseDraft(context, "branch.summary_created", "system", {
				fromId: entry.fromId,
				summary: truncateText(entry.summary, 1000),
				fromHook: entry.fromHook,
				sessionEntryId: entry.id,
			}),
			objectId: entry.fromId,
			importance: 0.8,
			ttlPolicy: "long_term",
		};
	}

	return undefined;
}

export function compactToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
	if (toolName === "write") {
		return {
			path: readPath(input),
			contentLength: typeof input.content === "string" ? input.content.length : undefined,
		};
	}
	if (toolName === "edit") {
		return {
			path: readPath(input),
			editCount: Array.isArray(input.edits) ? input.edits.length : undefined,
			edits: Array.isArray(input.edits) ? input.edits.slice(0, 10).map((edit) => compactUnknown(edit)) : undefined,
		};
	}
	if (toolName === "bash") {
		return {
			command: typeof input.command === "string" ? truncateText(input.command, 600) : undefined,
			timeout: numberField(input, "timeout"),
		};
	}
	return compactUnknown(input) as Record<string, unknown>;
}

function readPath(input: Record<string, unknown>): string | undefined {
	if (typeof input.path === "string") return input.path;
	if (typeof input.file_path === "string") return input.file_path;
	return undefined;
}

function numberField(input: Record<string, unknown>, key: string): number | undefined {
	return typeof input[key] === "number" ? input[key] : undefined;
}
