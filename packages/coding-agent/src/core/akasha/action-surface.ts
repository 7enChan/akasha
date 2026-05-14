import {
	type AkashaPolicyDecision,
	type AkashaPolicyRule,
	type AkashaRuntimePolicyAction,
	evaluateAkashaRuntimePolicy,
} from "./policy-kernel.js";
import type { AkashaEvent, AkashaEventDraft } from "./types.js";

export type AkashaActionSurfaceKind = "coding" | "gateway" | "daemon" | "browser" | "shell" | "filesystem" | "custom";
export type AkashaActionSurfaceCapabilityRisk = "low" | "medium" | "high" | "critical";

export interface AkashaActionSurfaceCapability {
	capabilityId: string;
	title: string;
	risk: AkashaActionSurfaceCapabilityRisk;
	actions?: string[];
	description?: string;
}

export interface AkashaActionSurface {
	surfaceId: string;
	kind: AkashaActionSurfaceKind;
	label: string;
	capabilities: AkashaActionSurfaceCapability[];
	metadata?: Record<string, string>;
}

export interface AkashaActionSurfaceRequest {
	requestId?: string;
	surfaceId: string;
	capabilityId: string;
	actionId: string;
	subject?: string;
	objectId?: string;
	payload?: Record<string, unknown>;
	evidenceEvents?: AkashaEvent[];
	rules?: AkashaPolicyRule[];
}

export interface AkashaResolvedActionSurfaceRequest {
	request: AkashaActionSurfaceRequest;
	surface?: AkashaActionSurface;
	capability?: AkashaActionSurfaceCapability;
	actionAllowed: boolean;
	missingCapability: boolean;
}

export interface AkashaActionSurfaceEventContext {
	sessionId: string;
	streamId: string;
	eventTime?: string;
	parentEventIds?: string[];
	correlationId?: string;
	sourceEventIds?: string[];
}

export interface AkashaActionSurfaceOutcomeInput {
	request: AkashaActionSurfaceRequest;
	resolution: AkashaResolvedActionSurfaceRequest;
	requestedEventId: string;
	succeeded: boolean;
	summary: string;
	error?: string;
	resultPayload?: Record<string, unknown>;
}

export class AkashaActionSurfaceRegistry {
	private readonly surfaces = new Map<string, AkashaActionSurface>();

	constructor(surfaces: AkashaActionSurface[] = []) {
		for (const surface of surfaces) this.register(surface);
	}

	register(surface: AkashaActionSurface): void {
		if (this.surfaces.has(surface.surfaceId)) {
			throw new Error(`Duplicate Akasha action surface: ${surface.surfaceId}`);
		}
		this.surfaces.set(surface.surfaceId, surface);
	}

	resolve(request: AkashaActionSurfaceRequest): AkashaResolvedActionSurfaceRequest {
		return resolveAkashaActionSurfaceRequest([...this.surfaces.values()], request);
	}

	list(): AkashaActionSurface[] {
		return [...this.surfaces.values()];
	}
}

export const AKASHA_CODING_ACTION_SURFACE: AkashaActionSurface = {
	surfaceId: "akasha.coding-agent",
	kind: "coding",
	label: "Akasha coding agent",
	capabilities: [
		{
			capabilityId: "read_project",
			title: "Read project files and search project text",
			risk: "low",
			actions: ["read", "ls", "grep", "find"],
		},
		{
			capabilityId: "modify_project",
			title: "Modify project files",
			risk: "high",
			actions: ["write", "edit"],
		},
		{
			capabilityId: "run_shell",
			title: "Run shell commands",
			risk: "high",
			actions: ["bash"],
		},
		{
			capabilityId: "time_syscall",
			title: "Write explicit Akasha time records",
			risk: "medium",
		},
		{
			capabilityId: "extension_tool",
			title: "Run extension-provided tools",
			risk: "medium",
		},
	],
};

export interface AkashaCodingToolSurfaceRequestInput {
	toolName: string;
	toolCallId: string;
	input: unknown;
}

export function createAkashaCodingToolSurfaceRequest(
	input: AkashaCodingToolSurfaceRequestInput,
): AkashaActionSurfaceRequest {
	return {
		requestId: input.toolCallId,
		surfaceId: AKASHA_CODING_ACTION_SURFACE.surfaceId,
		capabilityId: capabilityForCodingTool(input.toolName),
		actionId: input.toolName,
		subject: input.toolName,
		objectId: objectIdForCodingTool(input.toolName, input.input),
		payload: {
			toolName: input.toolName,
			toolCallId: input.toolCallId,
			input: safeToolInput(input.input),
		},
	};
}

export function resolveAkashaActionSurfaceRequest(
	surfaces: AkashaActionSurface[],
	request: AkashaActionSurfaceRequest,
): AkashaResolvedActionSurfaceRequest {
	const surface = surfaces.find((item) => item.surfaceId === request.surfaceId);
	const capability = surface?.capabilities.find((item) => item.capabilityId === request.capabilityId);
	const actionAllowed = capability?.actions === undefined || capability.actions.includes(request.actionId);
	return {
		request,
		surface,
		capability,
		actionAllowed,
		missingCapability: capability === undefined || !actionAllowed,
	};
}

export function buildAkashaActionSurfacePolicyAction(
	resolution: AkashaResolvedActionSurfaceRequest,
): AkashaRuntimePolicyAction {
	const { request, surface, capability } = resolution;
	return {
		type: "surface_action",
		subject: request.subject ?? surfaceSubject(surface, request.surfaceId),
		objectId: request.objectId,
		payload: {
			surfaceId: request.surfaceId,
			surfaceKind: surface?.kind ?? "custom",
			capabilityId: request.capabilityId,
			capabilityRisk: capability?.risk,
			actionId: request.actionId,
			requestId: request.requestId,
			missingCapability: resolution.missingCapability,
			actionPayload: request.payload,
		},
		evidenceEvents: request.evidenceEvents,
		rules: request.rules,
	};
}

export function evaluateAkashaActionSurfaceRequest(
	resolution: AkashaResolvedActionSurfaceRequest,
): AkashaPolicyDecision {
	return evaluateAkashaRuntimePolicy(buildAkashaActionSurfacePolicyAction(resolution));
}

export function createAkashaActionSurfaceRequestedDraft(
	context: AkashaActionSurfaceEventContext,
	resolution: AkashaResolvedActionSurfaceRequest,
): AkashaEventDraft {
	const { request, surface, capability } = resolution;
	return {
		kind: "action_surface.requested",
		sessionId: context.sessionId,
		streamId: context.streamId,
		eventTime: context.eventTime ?? new Date().toISOString(),
		actor: "agent",
		subjectId: request.subject ?? surfaceSubject(surface, request.surfaceId),
		objectId: request.objectId,
		parentEventIds: context.parentEventIds,
		correlationId: context.correlationId,
		sourceKey: `action-surface-requested:${request.requestId ?? request.surfaceId}:${request.capabilityId}:${
			request.actionId
		}`,
		payload: {
			surfaceId: request.surfaceId,
			surfaceKind: surface?.kind ?? "custom",
			capabilityId: request.capabilityId,
			capabilityRisk: capability?.risk,
			actionId: request.actionId,
			requestId: request.requestId,
			missingCapability: resolution.missingCapability,
			actionAllowed: resolution.actionAllowed,
			sourceEventIds: context.sourceEventIds ?? [],
			actionPayload: request.payload,
		},
		importance: capability?.risk === "critical" ? 0.9 : 0.6,
		ttlPolicy: "long_term",
	};
}

export function createAkashaActionSurfaceOutcomeDraft(
	context: AkashaActionSurfaceEventContext,
	input: AkashaActionSurfaceOutcomeInput,
): AkashaEventDraft {
	const { request, resolution } = input;
	const capability = resolution.capability;
	return {
		kind: input.succeeded ? "action_surface.completed" : "action_surface.failed",
		sessionId: context.sessionId,
		streamId: context.streamId,
		eventTime: context.eventTime ?? new Date().toISOString(),
		actor: "system",
		subjectId: request.subject ?? surfaceSubject(resolution.surface, request.surfaceId),
		objectId: request.objectId,
		parentEventIds: uniqueStrings([input.requestedEventId, ...(context.parentEventIds ?? [])]),
		correlationId: context.correlationId,
		sourceKey: `action-surface-outcome:${input.requestedEventId}`,
		payload: {
			surfaceId: request.surfaceId,
			surfaceKind: resolution.surface?.kind ?? "custom",
			capabilityId: request.capabilityId,
			capabilityRisk: capability?.risk,
			actionId: request.actionId,
			requestId: request.requestId,
			requestedEventId: input.requestedEventId,
			succeeded: input.succeeded,
			summary: input.summary,
			error: input.error,
			sourceEventIds: context.sourceEventIds ?? [],
			resultPayload: input.resultPayload,
		},
		importance: input.succeeded ? 0.6 : 0.85,
		ttlPolicy: "long_term",
	};
}

function surfaceSubject(surface: AkashaActionSurface | undefined, surfaceId: string): string {
	return `${surface?.kind ?? "surface"}:${surfaceId}`;
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

function capabilityForCodingTool(toolName: string): string {
	if (toolName === "read" || toolName === "ls" || toolName === "grep" || toolName === "find") return "read_project";
	if (toolName === "write" || toolName === "edit") return "modify_project";
	if (toolName === "bash") return "run_shell";
	if (toolName.startsWith("akasha_")) return "time_syscall";
	return "extension_tool";
}

function objectIdForCodingTool(toolName: string, input: unknown): string | undefined {
	if (!isRecord(input)) return toolName;
	for (const key of ["path", "file_path", "command", "query"]) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return toolName;
}

function safeToolInput(input: unknown): Record<string, unknown> {
	if (!isRecord(input)) return { value: String(input) };
	return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
