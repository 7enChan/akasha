import { isAbsolute, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/akasha-agent-core";
import { v7 as uuidv7 } from "uuid";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ModelSelectEvent,
	SessionStartEvent,
	ThinkingLevelSelectEvent,
	UserBashEvent,
} from "../extensions/types.js";
import type { SessionEntry } from "../session-manager.js";
import type {
	ResolvedAkashaEmbeddingSettings,
	ResolvedAkashaMaintenanceSettings,
	ResolvedAkashaReflectionSettings,
	ResolvedAkashaSettings,
} from "../settings-manager.js";
import { buildTemporalBrief, buildTemporalBriefWithEmbeddings } from "./brief.js";
import {
	appendAkashaCallbackInboxEvent,
	appendAkashaCallbackInboxStatus,
	listAkashaActionableCallbackPrompts,
} from "./callback-inbox.js";
import { registerAkashaCommands } from "./commands.js";
import { createAkashaEmbeddingProvider } from "./embedding-provider.js";
import { JsonlAkashaEmbeddingStore } from "./embedding-store.js";
import type { AkashaHeartbeatController } from "./heartbeat.js";
import { createAkashaHeartbeat } from "./heartbeat.js";
import { JsonlAkashaStore } from "./jsonl-store.js";
import { runAkashaMaintenancePass } from "./maintenance.js";
import {
	mapMessageEnd,
	mapSessionEntry,
	mapToolCompleted,
	mapToolOutcome,
	mapToolRequested,
	truncateText,
} from "./mapper.js";
import { createMemoryAppliedDraft, createMemoryOutcomeDraft } from "./memory-recall-events.js";
import {
	type AkashaMemoryRecallScope,
	akashaRecallScopeMatches,
	readAkashaMemoryRecallScope,
} from "./memory-recall-scope.js";
import { deriveOpenLoopEvents } from "./open-loops.js";
import { rulesForAkashaPolicyProfile } from "./policy-kernel.js";
import { createAkashaTemporalKernel } from "./temporal-kernel.js";
import {
	auditAkashaTimeSyscalls,
	createAkashaTimeSyscallRepairedDraft,
	findUnrepairedTimeSyscallMissingAudits,
	parentFallbacksToAudit,
} from "./time-syscall-audit.js";
import {
	appendAkashaCommitment,
	appendAkashaCommitmentResolution,
	appendAkashaPrediction,
	appendAkashaPredictionCheck,
	checkPredictionSchema,
	createCommitmentSchema,
	createPredictionSchema,
	eventToolResult,
	isAkashaTimeSyscallToolName,
	resolveCommitmentSchema,
} from "./time-syscalls.js";
import type { AkashaEvent, AkashaEventDraft, AkashaEventKind, AkashaStore } from "./types.js";

const BUILT_IN_PATH = "<built-in:akasha>";

export interface AkashaCollectorOptions {
	agentDir: string;
	settings: ResolvedAkashaSettings;
}

export function resolveAkashaEventLogPath(
	settings: Pick<ResolvedAkashaSettings, "eventLogDir">,
	agentDir: string,
	sessionId: string,
): string {
	const baseDir = settings.eventLogDir
		? isAbsolute(settings.eventLogDir)
			? settings.eventLogDir
			: resolve(agentDir, settings.eventLogDir)
		: join(agentDir, "akasha", "events");
	return join(baseDir, `${sessionId}.jsonl`);
}

export function resolveAkashaEmbeddingIndexPath(
	settings: Pick<ResolvedAkashaSettings, "embedding">,
	agentDir: string,
	sessionId: string,
): string {
	const embedding = resolveEmbeddingSettings(settings.embedding);
	const baseDir = embedding.indexDir
		? isAbsolute(embedding.indexDir)
			? embedding.indexDir
			: resolve(agentDir, embedding.indexDir)
		: join(agentDir, "akasha", "embeddings");
	return join(baseDir, `${sessionId}.jsonl`);
}

export function createAkashaCollectorExtension(options: AkashaCollectorOptions): ExtensionFactory {
	return (akasha: ExtensionAPI) => {
		let store: JsonlAkashaStore | undefined;
		let embeddingStore: JsonlAkashaEmbeddingStore | undefined;
		let heartbeat: AkashaHeartbeatController | undefined;
		const embeddingSettings = resolveEmbeddingSettings(options.settings.embedding);
		const reflectionSettings = resolveReflectionSettings(options.settings.reflection);
		const maintenanceSettings = resolveMaintenanceSettings(options.settings.maintenance);
		const privacySettings = options.settings.privacy ?? { redactSecrets: true };
		const embeddingProvider = createAkashaEmbeddingProvider(embeddingSettings);
		const policyRules = rulesForAkashaPolicyProfile(options.settings.policyProfile);
		let sessionId: string | undefined;
		let streamId = "unknown";
		let agentRunId = `boot-${uuidv7()}`;
		let sourceCounter = 0;

		let currentTurnEventId: string | undefined;
		let latestUserEventId: string | undefined;
		let latestAssistantEventId: string | undefined;
		let latestLeafEventId: string | undefined;

		const toolRequestEventIds = new Map<string, string>();
		const toolCompletedEventIds = new Map<string, string>();
		const toolAssistantParentIds = new Map<string, string>();
		const sessionEntryEventIds = new Map<string, string>();
		const injectedInboxItemIds = new Set<string>();
		const injectedStrictRepairKeys = new Set<string>();
		const toolMemoryApplications = new Map<string, { recallEventId: string; appliedEventId: string }>();
		let latestRecall:
			| {
					eventId: string;
					scope?: AkashaMemoryRecallScope;
			  }
			| undefined;

		const nowIso = () => new Date().toISOString();
		const nextSourceKey = (scope: string) =>
			`akasha:${sessionId ?? "unknown"}:${agentRunId}:${scope}:${++sourceCounter}`;

		const getStore = (): AkashaStore | undefined => store;

		const createKernel = () => {
			if (!store || !sessionId) return undefined;
			return createAkashaTemporalKernel({
				store,
				sessionId,
				streamId,
				agentDir: options.agentDir,
				eventLogDir: options.settings.eventLogDir,
				reflection: reflectionSettings,
				policyRules,
			});
		};

		const ensureStore = (ctx: ExtensionContext): JsonlAkashaStore => {
			const activeSessionId = ctx.sessionManager.getSessionId();
			if (!store || sessionId !== activeSessionId) {
				sessionId = activeSessionId;
				streamId = `session:${activeSessionId}`;
				store = new JsonlAkashaStore(
					resolveAkashaEventLogPath(options.settings, options.agentDir, activeSessionId),
					{
						redactSecrets: privacySettings.redactSecrets,
					},
				);
				embeddingStore = undefined;
				resetEphemeralState();
			}
			return store;
		};

		const ensureEmbeddingStore = (ctx: ExtensionContext): JsonlAkashaEmbeddingStore | undefined => {
			if (!embeddingProvider || !embeddingSettings.enabled) return undefined;
			const activeSessionId = ctx.sessionManager.getSessionId();
			if (!embeddingStore || sessionId !== activeSessionId) {
				embeddingStore = new JsonlAkashaEmbeddingStore(
					resolveAkashaEmbeddingIndexPath(options.settings, options.agentDir, activeSessionId),
				);
			}
			return embeddingStore;
		};

		const resetEphemeralState = (): void => {
			currentTurnEventId = undefined;
			latestUserEventId = undefined;
			latestAssistantEventId = undefined;
			latestLeafEventId = undefined;
			toolRequestEventIds.clear();
			toolCompletedEventIds.clear();
			toolAssistantParentIds.clear();
			sessionEntryEventIds.clear();
			injectedInboxItemIds.clear();
			injectedStrictRepairKeys.clear();
			toolMemoryApplications.clear();
			latestRecall = undefined;
		};

		const append = (draft: AkashaEventDraft): AkashaEvent | undefined => {
			if (!store) return undefined;
			const event = store.append(draft);
			latestLeafEventId = event.eventId;
			return event;
		};

		const materializeOpenLoops = (): void => {
			if (!store || !sessionId) return;
			const drafts = deriveOpenLoopEvents(store.buildTimeline({ limit: 500 }), sessionId, streamId);
			for (const draft of drafts) {
				append(draft);
			}
		};

		const runMaintenance = async (ctx: ExtensionContext): Promise<void> => {
			if (!maintenanceSettings.enabled || !store || !sessionId) return;
			const activeEmbeddingStore = ensureEmbeddingStore(ctx);
			await runAkashaMaintenancePass(store, {
				sessionId,
				streamId,
				reflection: reflectionSettings,
				embeddingStore: activeEmbeddingStore,
				embeddingProvider,
			});
		};

		const restartHeartbeat = (ctx: ExtensionContext): void => {
			heartbeat?.stop();
			heartbeat = undefined;
			if (!maintenanceSettings.enabled || !maintenanceSettings.heartbeatEnabled) return;
			heartbeat = createAkashaHeartbeat({
				intervalMinutes: maintenanceSettings.heartbeatIntervalMinutes,
				run: () => runMaintenance(ctx),
			});
			heartbeat.start();
			if (maintenanceSettings.runOnSessionStart) {
				void heartbeat.runNow();
			}
		};

		const parents = (...ids: Array<string | undefined>): string[] => {
			return [...new Set(ids.filter((id): id is string => !!id))];
		};

		const baseDraft = (
			kind: AkashaEventKind,
			payload: Record<string, unknown>,
			options: Partial<AkashaEventDraft> = {},
		): AkashaEventDraft => ({
			kind,
			sessionId: sessionId ?? "unknown",
			streamId,
			eventTime: nowIso(),
			actor: "system",
			sourceKey: nextSourceKey(kind),
			parentEventIds: latestLeafEventId ? [latestLeafEventId] : [],
			payload,
			importance: 0.5,
			ttlPolicy: "session",
			...options,
		});

		const mapStartKind = (reason: SessionStartEvent["reason"]): AkashaEventKind => {
			if (reason === "resume") return "session.resumed";
			if (reason === "fork") return "session.forked";
			if (reason === "reload") return "session.reloaded";
			return "session.started";
		};

		const reconcileSessionEntry = (entry: SessionEntry, parentId?: string): AkashaEvent | undefined => {
			if (!sessionId) return undefined;
			const mapped = mapSessionEntry(entry, {
				sessionId,
				streamId,
				eventTime: entry.timestamp,
				sourceKey: `session-entry:${sessionId}:${entry.id}:${entry.type}`,
				parentEventIds: parents(parentId, entry.parentId ? sessionEntryEventIds.get(entry.parentId) : undefined),
			});
			if (!mapped) return undefined;
			const event = append(mapped);
			if (event) {
				sessionEntryEventIds.set(entry.id, event.eventId);
			}
			return event;
		};

		const reconcileBranchEntries = (ctx: ExtensionContext, parentId?: string): void => {
			for (const entry of ctx.sessionManager.getBranch()) {
				reconcileSessionEntry(entry, parentId);
			}
		};

		const rememberAssistantToolParents = (message: AgentMessage, parentEventId: string): void => {
			if (message.role !== "assistant" || !Array.isArray(message.content)) return;
			for (const block of message.content) {
				if (
					typeof block === "object" &&
					block !== null &&
					"type" in block &&
					block.type === "toolCall" &&
					"id" in block &&
					typeof block.id === "string"
				) {
					toolAssistantParentIds.set(block.id, parentEventId);
				}
			}
		};

		const syscallContext = (ctx: ExtensionContext, toolCallId: string) => {
			ensureStore(ctx);
			return {
				store: store!,
				sessionId: sessionId ?? ctx.sessionManager.getSessionId(),
				streamId,
				now: nowIso,
				parentEventIds: parents(latestLeafEventId, currentTurnEventId, latestAssistantEventId),
				correlationId: currentTurnEventId,
				toolCallId,
				sourceKeyPrefix: `akasha-syscall:${sessionId ?? ctx.sessionManager.getSessionId()}`,
				agentDir: options.agentDir,
			};
		};

		registerAkashaCommands(akasha, getStore, {
			agentDir: options.agentDir,
			eventLogDir: options.settings.eventLogDir,
			reflection: reflectionSettings,
		});

		akasha.registerTool({
			name: "akasha_create_commitment",
			label: "akasha commitment",
			description:
				"Create an explicit Akasha commitment when the agent or user takes on future responsibility that should be tracked.",
			promptSnippet: "Record future commitments in Akasha time using akasha_create_commitment.",
			promptGuidelines: [
				"When you make a concrete future commitment, call akasha_create_commitment instead of relying only on natural language.",
				"Include dueTime when there is a clear future check point, and resolutionCriteria when completion can be judged.",
			],
			parameters: createCommitmentSchema,
			execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
				eventToolResult(appendAkashaCommitment(syscallContext(ctx, toolCallId), params)),
		});

		akasha.registerTool({
			name: "akasha_resolve_commitment",
			label: "akasha resolve commitment",
			description: "Resolve an existing Akasha commitment with optional evidence.",
			promptSnippet: "Resolve tracked Akasha commitments with akasha_resolve_commitment.",
			promptGuidelines: [
				"When resolving a pending callback, include callbackId or inboxItemId so Akasha can consume the inbox item and complete the callback.",
			],
			parameters: resolveCommitmentSchema,
			execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
				eventToolResult(appendAkashaCommitmentResolution(syscallContext(ctx, toolCallId), params)),
		});

		akasha.registerTool({
			name: "akasha_create_prediction",
			label: "akasha prediction",
			description:
				"Create an explicit Akasha prediction when the agent makes a falsifiable expectation that should be checked later.",
			promptSnippet: "Record falsifiable predictions in Akasha time using akasha_create_prediction.",
			promptGuidelines: [
				"When you make a concrete prediction about future outcomes, call akasha_create_prediction.",
				"Use checkAfter and resolutionCriteria when the prediction has a natural validation point.",
			],
			parameters: createPredictionSchema,
			execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
				eventToolResult(appendAkashaPrediction(syscallContext(ctx, toolCallId), params)),
		});

		akasha.registerTool({
			name: "akasha_check_prediction",
			label: "akasha check prediction",
			description: "Check or correct an Akasha prediction with the observed actual outcome.",
			promptSnippet: "Check tracked Akasha predictions with akasha_check_prediction.",
			promptGuidelines: [
				"When checking a pending callback, include callbackId or inboxItemId so Akasha can consume the inbox item and complete the callback.",
			],
			parameters: checkPredictionSchema,
			execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
				eventToolResult(appendAkashaPredictionCheck(syscallContext(ctx, toolCallId), params)),
		});

		akasha.on("session_start", (event, ctx) => {
			ensureStore(ctx);
			agentRunId = `session-${uuidv7()}`;
			resetEphemeralState();

			const started = append(
				baseDraft(mapStartKind(event.reason), {
					reason: event.reason,
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile(),
					previousSessionFile: event.previousSessionFile,
				}),
			);

			reconcileBranchEntries(ctx, started?.eventId);
			restartHeartbeat(ctx);
		});

		akasha.on("session_shutdown", (event, ctx) => {
			ensureStore(ctx);
			append(
				baseDraft(
					"session.shutdown",
					{
						reason: event.reason,
						targetSessionFile: event.targetSessionFile,
					},
					{
						actor: "system",
						importance: 0.35,
					},
				),
			);
			heartbeat?.stop();
			heartbeat = undefined;
		});

		akasha.on("agent_start", () => {
			agentRunId = `agent-${uuidv7()}`;
			currentTurnEventId = undefined;
			latestUserEventId = undefined;
			latestAssistantEventId = undefined;
			latestRecall = undefined;
		});

		akasha.on("turn_start", (event, ctx) => {
			ensureStore(ctx);
			latestRecall = undefined;
			const turn = append(
				baseDraft(
					"turn.started",
					{
						turnIndex: event.turnIndex,
					},
					{
						eventTime: new Date(event.timestamp).toISOString(),
						sourceKey: `turn:${sessionId}:${agentRunId}:${event.turnIndex}:started`,
						parentEventIds: latestLeafEventId ? [latestLeafEventId] : [],
						importance: 0.45,
					},
				),
			);
			currentTurnEventId = turn?.eventId;
		});

		akasha.on("turn_end", async (event, ctx) => {
			ensureStore(ctx);
			const completed = append(
				baseDraft(
					"turn.completed",
					{
						turnIndex: event.turnIndex,
						finalRole: event.message.role,
						toolResultCount: event.toolResults.length,
					},
					{
						sourceKey: `turn:${sessionId}:${agentRunId}:${event.turnIndex}:completed`,
						parentEventIds: parents(latestAssistantEventId, currentTurnEventId),
						importance: 0.45,
					},
				),
			);
			currentTurnEventId = completed?.eventId ?? currentTurnEventId;
			materializeOpenLoops();
			if (maintenanceSettings.enabled && maintenanceSettings.runOnTurnEnd) {
				await runMaintenance(ctx).catch(() => undefined);
			}
		});

		akasha.on("message_end", (event, ctx) => {
			ensureStore(ctx);

			let parentEventIds: string[];
			if (event.message.role === "user") {
				parentEventIds = parents(currentTurnEventId, latestLeafEventId);
			} else if (event.message.role === "assistant") {
				parentEventIds = parents(latestUserEventId, currentTurnEventId, latestLeafEventId);
			} else if (event.message.role === "toolResult") {
				parentEventIds = parents(
					toolCompletedEventIds.get(event.message.toolCallId),
					toolRequestEventIds.get(event.message.toolCallId),
					currentTurnEventId,
				);
			} else {
				parentEventIds = parents(currentTurnEventId, latestLeafEventId);
			}

			const mapped = mapMessageEnd(event.message, {
				sessionId: sessionId ?? ctx.sessionManager.getSessionId(),
				streamId,
				eventTime: new Date(event.message.timestamp).toISOString(),
				sourceKey: nextSourceKey(`message:${event.message.role}`),
				parentEventIds,
				correlationId: currentTurnEventId,
			});
			if (!mapped) return undefined;

			const recorded = append(mapped);
			if (recorded && event.message.role === "user") {
				latestUserEventId = recorded.eventId;
			}
			if (recorded && event.message.role === "assistant") {
				latestAssistantEventId = recorded.eventId;
				rememberAssistantToolParents(event.message, recorded.eventId);
				const audit = auditAkashaTimeSyscalls(recorded, {
					hasSyscallToolCall: hasAkashaTimeSyscallToolCall(event.message),
					sourceKeyPrefix: `time-syscall-audit:${sessionId}:${recorded.eventId}`,
					mode: options.settings.temporalProtocol.syscallAuditMode,
				});
				const auditEvent = audit.audit ? append(audit.audit) : undefined;
				if (hasAkashaTimeSyscallToolCall(event.message) && store) {
					for (const missing of findUnrepairedTimeSyscallMissingAudits(store.buildTimeline({ limit: 200 })).slice(
						-3,
					)) {
						append(createAkashaTimeSyscallRepairedDraft(missing, recorded, auditEvent));
					}
				}
				for (const draft of parentFallbacksToAudit(audit.fallbacks, auditEvent?.eventId)) {
					append(draft);
				}
			}
			return undefined;
		});

		akasha.on("tool_call", (event, ctx) => {
			ensureStore(ctx);
			const parentEventIds = parents(
				toolAssistantParentIds.get(event.toolCallId),
				latestAssistantEventId,
				currentTurnEventId,
			);
			const gateDecision = createKernel()?.evaluatePolicy(event, options.settings.actionGate) ?? {
				allow: true,
				action: "allow" as const,
				severity: "info" as const,
				eventIds: [],
			};
			let policyEventId: string | undefined;
			if (gateDecision.rule) {
				const policy = append(
					baseDraft(
						"policy.evaluated",
						{
							actionType: "tool_call",
							subject: event.toolName,
							objectId: event.toolName,
							action: gateDecision.action ?? (gateDecision.allow ? "allow" : "block"),
							severity: gateDecision.severity ?? "warning",
							reason: gateDecision.reason,
							ruleId: gateDecision.rule,
							evidenceEventIds: gateDecision.eventIds,
							validationPlan: gateDecision.validationPlan,
							confirmationPrompt: gateDecision.confirmationPrompt,
							callback: gateDecision.callback,
						},
						{
							actor: "system",
							subjectId: "akasha.policy_kernel",
							objectId: event.toolName,
							toolCallId: event.toolCallId,
							sourceKey: `tool-call:${sessionId}:${event.toolCallId}:policy:${gateDecision.rule}`,
							parentEventIds,
							correlationId: currentTurnEventId,
							importance: gateDecision.allow ? 0.55 : 0.9,
							ttlPolicy: "long_term",
						},
					),
				);
				policyEventId = policy?.eventId;
			}
			if (gateDecision.action === "defer" && gateDecision.callback) {
				const scheduled = createKernel()?.scheduleCallback({
					callbackId: gateDecision.callback.callbackId,
					kind: "scheduled_callback",
					dueTime: gateDecision.callback.dueTime,
					summary: gateDecision.callback.summary,
					targetEventId: gateDecision.callback.targetEventId,
					parentEventIds: parents(policyEventId, ...parentEventIds),
					subjectId: "akasha.policy_kernel",
					sourceKey: `tool-call:${sessionId}:${event.toolCallId}:deferred:${gateDecision.callback.callbackId}`,
					importance: 0.8,
				});
				if (scheduled) latestLeafEventId = scheduled.eventId;
				return {
					block: true,
					reason: gateDecision.reason ?? "Akasha deferred this tool call.",
				};
			}
			if (!gateDecision.allow) {
				append(
					baseDraft(
						"tool.blocked",
						{
							toolName: event.toolName,
							reason: gateDecision.reason,
							rule: gateDecision.rule,
							action: gateDecision.action,
							blockedEventIds: gateDecision.eventIds,
							validationPlan: gateDecision.validationPlan,
							confirmationPrompt: gateDecision.confirmationPrompt,
						},
						{
							actor: "system",
							subjectId: "akasha.action_gate",
							objectId: event.toolName,
							toolCallId: event.toolCallId,
							sourceKey: `tool-call:${sessionId}:${event.toolCallId}:blocked`,
							parentEventIds: parents(policyEventId, ...parentEventIds),
							correlationId: currentTurnEventId,
							importance: 0.95,
							ttlPolicy: "long_term",
						},
					),
				);
				return {
					block: true,
					reason: formatPolicyBlockReason(gateDecision),
				};
			}
			const matchingRecall =
				latestRecall &&
				akashaRecallScopeMatches({
					scope: latestRecall.scope,
					currentTurnEventId,
					correlationId: currentTurnEventId,
				})
					? latestRecall
					: undefined;
			const applied = matchingRecall
				? append(
						createMemoryAppliedDraft({
							sessionId: sessionId ?? ctx.sessionManager.getSessionId(),
							streamId,
							recallEventId: matchingRecall.eventId,
							actionType: "tool_call",
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							parentEventIds: parents(matchingRecall.eventId, policyEventId, ...parentEventIds),
							correlationId: currentTurnEventId,
							sourceKey: `memory-applied:${sessionId}:${event.toolCallId}:${matchingRecall.eventId}`,
							eventTime: nowIso(),
						}),
					)
				: undefined;
			if (applied && matchingRecall) {
				toolMemoryApplications.set(event.toolCallId, {
					recallEventId: matchingRecall.eventId,
					appliedEventId: applied.eventId,
				});
			}
			const requested = append(
				mapToolRequested(event, {
					sessionId: sessionId ?? ctx.sessionManager.getSessionId(),
					streamId,
					eventTime: nowIso(),
					sourceKey: `tool-call:${sessionId}:${event.toolCallId}:requested`,
					parentEventIds: parents(applied?.eventId, ...parentEventIds),
					correlationId: currentTurnEventId,
				}),
			);
			if (requested) {
				toolRequestEventIds.set(event.toolCallId, requested.eventId);
			}
			return undefined;
		});

		akasha.on("tool_result", (event, ctx) => {
			ensureStore(ctx);
			const requestEventId = toolRequestEventIds.get(event.toolCallId);
			const completed = append(
				mapToolCompleted(event, {
					sessionId: sessionId ?? ctx.sessionManager.getSessionId(),
					streamId,
					eventTime: nowIso(),
					sourceKey: `tool-call:${sessionId}:${event.toolCallId}:completed`,
					parentEventIds: parents(requestEventId, currentTurnEventId),
					correlationId: currentTurnEventId,
				}),
			);
			if (completed) {
				toolCompletedEventIds.set(event.toolCallId, completed.eventId);
				const application = toolMemoryApplications.get(event.toolCallId);
				if (application) {
					append(
						createMemoryOutcomeDraft({
							kind: event.isError ? "memory.weakened" : "memory.reinforced",
							sessionId: sessionId ?? ctx.sessionManager.getSessionId(),
							streamId,
							recallEventId: application.recallEventId,
							appliedEventId: application.appliedEventId,
							outcomeEvent: completed,
							reason: event.isError ? "tool_result_failed" : "tool_result_succeeded",
							sourceKey: `memory-outcome:${sessionId}:${event.toolCallId}:${
								event.isError ? "weakened" : "reinforced"
							}`,
							eventTime: nowIso(),
						}),
					);
				}
			}

			const outcome = mapToolOutcome(event, {
				sessionId: sessionId ?? ctx.sessionManager.getSessionId(),
				streamId,
				eventTime: nowIso(),
				sourceKey: `tool-call:${sessionId}:${event.toolCallId}:outcome:${event.toolName}`,
				parentEventIds: parents(completed?.eventId, requestEventId),
				correlationId: currentTurnEventId,
			});
			if (outcome) append(outcome);
			return undefined;
		});

		akasha.on("session_compact", (event, ctx) => {
			ensureStore(ctx);
			reconcileSessionEntry(event.compactionEntry, parents(currentTurnEventId, latestLeafEventId)[0]);
		});

		akasha.on("session_tree", (event, ctx) => {
			ensureStore(ctx);
			if (event.summaryEntry) {
				reconcileSessionEntry(event.summaryEntry, parents(currentTurnEventId, latestLeafEventId)[0]);
			}
		});

		akasha.on("model_select", (event, ctx) => {
			ensureStore(ctx);
			append(mapModelSelect(event));
		});

		akasha.on("thinking_level_select", (event, ctx) => {
			ensureStore(ctx);
			append(mapThinkingLevelSelect(event));
		});

		akasha.on("user_bash", (event, ctx) => {
			ensureStore(ctx);
			append(mapUserBash(event));
			return undefined;
		});

		akasha.on("context", async (event, ctx) => {
			ensureStore(ctx);
			if (!store) return undefined;
			const activeStore = store;
			const messages: AgentMessage[] = [...event.messages];

			const lastUserMessage = [...event.messages].reverse().find((message) => message.role === "user");
			const queryText = lastUserMessage ? userMessageText(lastUserMessage) : undefined;
			if (options.settings.actionGate.enabled) {
				const result = createKernel()?.buildActionContext({
					cwd: ctx.cwd,
					settings: options.settings.actionGate,
					holographicMemory: options.settings.holographicMemory,
					latestUserText: queryText,
					parentEventIds: parents(currentTurnEventId, latestLeafEventId),
					correlationId: currentTurnEventId,
					sourceKey: nextSourceKey("action-gate"),
					turnEventId: currentTurnEventId,
				});
				const gate = result?.gate;
				if (gate) {
					if (result.auditEvent) latestLeafEventId = result.auditEvent.eventId;
					if (result.recalledEvent) {
						latestRecall = {
							eventId: result.recalledEvent.eventId,
							scope: readAkashaMemoryRecallScope(result.recalledEvent),
						};
					}
					messages.push({
						role: "custom",
						customType: "akasha.action_gate",
						content: gate.text,
						display: false,
						details: {
							source: BUILT_IN_PATH,
							eventIds: gate.eventIds,
							auditEventId: result?.auditEvent?.eventId,
							sections: gate.sections,
						},
						timestamp: Date.now(),
					});
				}
			}

			const inboxContext = injectPendingCallbackInboxContext();
			if (inboxContext) {
				messages.push({
					role: "custom",
					customType: "akasha.pending_callbacks",
					content: inboxContext.text,
					display: false,
					details: {
						source: BUILT_IN_PATH,
						eventIds: inboxContext.eventIds,
						inboxItemIds: inboxContext.inboxItemIds,
					},
					timestamp: Date.now(),
				});
			}

			const strictRepairContext = injectStrictSyscallRepairContext();
			if (strictRepairContext) {
				messages.push({
					role: "custom",
					customType: "akasha.syscall_repair",
					content: strictRepairContext.text,
					display: false,
					details: {
						source: BUILT_IN_PATH,
						eventIds: strictRepairContext.eventIds,
						missingEventIds: strictRepairContext.missingEventIds,
					},
					timestamp: Date.now(),
				});
			}

			if (options.settings.injectTemporalBrief) {
				const activeEmbeddingStore = ensureEmbeddingStore(ctx);
				const brief =
					embeddingProvider && activeEmbeddingStore
						? await buildTemporalBriefWithEmbeddings(activeStore, {
								embeddingStore: activeEmbeddingStore,
								embeddingProvider,
								maxEvents: options.settings.maxBriefEvents,
								queryText,
							}).catch(() =>
								buildTemporalBrief(activeStore, {
									maxEvents: options.settings.maxBriefEvents,
									queryText,
								}),
							)
						: buildTemporalBrief(activeStore, {
								maxEvents: options.settings.maxBriefEvents,
								queryText,
							});
				if (brief) {
					messages.push({
						role: "custom",
						customType: "akasha.temporal_brief",
						content: brief.text,
						display: false,
						details: {
							source: BUILT_IN_PATH,
							eventIds: brief.events.map((item) => item.eventId),
						},
						timestamp: Date.now(),
					});
				}
			}

			return messages.length > event.messages.length ? { messages } : undefined;
		});

		function injectPendingCallbackInboxContext():
			| { text: string; eventIds: string[]; inboxItemIds: string[] }
			| undefined {
			if (!store || !sessionId) return undefined;
			const items = listAkashaActionableCallbackPrompts(options.agentDir)
				.filter((item) => !injectedInboxItemIds.has(item.prompt.id))
				.slice(0, 5);
			if (items.length === 0) return undefined;
			const eventIds: string[] = [];
			for (const item of items) {
				const injected = appendAkashaCallbackInboxEvent(store, "callback.inbox.injected", item.prompt, {
					sessionId,
					streamId,
					consumerSessionId: sessionId,
					parentEventIds: parents(
						currentTurnEventId,
						latestLeafEventId,
						item.prompt.claimEventId,
						item.prompt.dueEventId,
					),
					sourceKeySuffix: `context:${sessionId}`,
				});
				appendAkashaCallbackInboxStatus(options.agentDir, item.prompt, {
					status: "injected",
					eventId: injected.eventId,
					consumerSessionId: sessionId,
				});
				injectedInboxItemIds.add(item.prompt.id);
				eventIds.push(injected.eventId);
			}
			const text = [
				"<akasha_pending_callbacks>",
				...items.map((item, index) =>
					[
						`${index + 1}. ${item.prompt.summary}`,
						`   inboxItemId: ${item.prompt.id}`,
						`   callbackId: ${item.prompt.callbackId}`,
						item.prompt.targetEventId ? `   targetEventId: ${item.prompt.targetEventId}` : undefined,
						"   obligation: Review the causal chain, act only if still relevant, then close the loop with akasha_resolve_commitment or akasha_check_prediction using this callbackId or inboxItemId.",
					]
						.filter((line): line is string => Boolean(line))
						.join("\n"),
				),
				"</akasha_pending_callbacks>",
			].join("\n");
			return {
				text,
				eventIds,
				inboxItemIds: items.map((item) => item.prompt.id),
			};
		}

		function injectStrictSyscallRepairContext():
			| { text: string; eventIds: string[]; missingEventIds: string[] }
			| undefined {
			if (!store || !sessionId || options.settings.temporalProtocol.syscallAuditMode !== "strict") return undefined;
			const missing = findUnrepairedTimeSyscallMissingAudits(store.buildTimeline({ limit: 200 }))
				.filter((event) => !injectedStrictRepairKeys.has(strictRepairKey(event.eventId)))
				.slice(-3);
			if (missing.length === 0) return undefined;
			const missingEventIds = missing.map((event) => event.eventId);
			const assistantEventIds = missing
				.map((event) =>
					typeof event.payload.assistantEventId === "string"
						? event.payload.assistantEventId
						: typeof event.objectId === "string"
							? event.objectId
							: undefined,
				)
				.filter((eventId): eventId is string => Boolean(eventId));
			const injected = append({
				kind: "time_syscall.repair_prompt.injected",
				sessionId,
				streamId,
				eventTime: nowIso(),
				actor: "system",
				subjectId: "akasha.time_syscall_audit",
				objectId: "strict_repair",
				sourceKey: nextSourceKey(`time-syscall-repair:${missingEventIds.join(",")}`),
				parentEventIds: parents(currentTurnEventId, latestLeafEventId, ...missingEventIds),
				correlationId: currentTurnEventId,
				payload: {
					missingEventIds,
					assistantEventIds,
					repairRequired: true,
					instruction:
						"Repair missing future-responsibility syscalls before continuing normal work. If still valid, call akasha_create_commitment or akasha_create_prediction with sourceEventIds.",
				},
				importance: 0.9,
				ttlPolicy: "long_term",
			});
			for (const event of missing) injectedStrictRepairKeys.add(strictRepairKey(event.eventId));
			const text = [
				"<akasha_time_syscall_repair_required>",
				"Strict temporal protocol is active. Do not continue normal work or restate unresolved future responsibility before repairing it.",
				...missing.map((event, index) =>
					[
						`${index + 1}. Missing syscall audit: ${event.eventId}`,
						`   assistantEventId: ${String(event.payload.assistantEventId ?? event.objectId ?? "")}`,
						"   obligation: if still valid, call akasha_create_commitment or akasha_create_prediction now.",
						"   sourceEventIds: include this missing audit id or its assistantEventId.",
						"   if obsolete: state why it is obsolete and do not recreate it.",
					].join("\n"),
				),
				"</akasha_time_syscall_repair_required>",
			].join("\n");
			return {
				text,
				eventIds: injected ? [injected.eventId] : [],
				missingEventIds,
			};
		}

		function strictRepairKey(eventId: string): string {
			return `${eventId}:${currentTurnEventId ?? "no-turn"}`;
		}

		function mapModelSelect(event: ModelSelectEvent): AkashaEventDraft {
			return baseDraft(
				"model.changed",
				{
					provider: event.model.provider,
					modelId: event.model.id,
					modelName: event.model.name,
					previousProvider: event.previousModel?.provider,
					previousModelId: event.previousModel?.id,
					source: event.source,
				},
				{
					objectId: `${event.model.provider}/${event.model.id}`,
					sourceKey: nextSourceKey(`model:${event.source}:${event.model.provider}:${event.model.id}`),
					parentEventIds: parents(currentTurnEventId, latestLeafEventId),
					importance: 0.45,
					ttlPolicy: "session",
				},
			);
		}

		function mapThinkingLevelSelect(event: ThinkingLevelSelectEvent): AkashaEventDraft {
			return baseDraft(
				"thinking_level.changed",
				{
					thinkingLevel: event.level,
					previousThinkingLevel: event.previousLevel,
				},
				{
					objectId: event.level,
					sourceKey: nextSourceKey(`thinking:${event.previousLevel}:${event.level}`),
					parentEventIds: parents(currentTurnEventId, latestLeafEventId),
					importance: 0.4,
					ttlPolicy: "session",
				},
			);
		}

		function mapUserBash(event: UserBashEvent): AkashaEventDraft {
			return baseDraft(
				"command.executed",
				{
					command: truncateText(event.command, 600),
					excludeFromContext: event.excludeFromContext,
					cwd: event.cwd,
					source: "user_bash",
				},
				{
					actor: "user",
					objectId: truncateText(event.command, 120),
					sourceKey: nextSourceKey("user-bash"),
					parentEventIds: parents(currentTurnEventId, latestLeafEventId),
					importance: 0.7,
					ttlPolicy: event.excludeFromContext ? "session" : "long_term",
				},
			);
		}
	};
}

function resolveEmbeddingSettings(
	settings: ResolvedAkashaSettings["embedding"] | undefined,
): ResolvedAkashaEmbeddingSettings {
	return {
		enabled: settings?.enabled ?? false,
		provider: settings?.provider ?? "off",
		model: settings?.model ?? "text-embedding-3-small",
		baseUrl: settings?.baseUrl ?? "https://api.openai.com/v1/embeddings",
		apiKeyEnv: settings?.apiKeyEnv ?? "OPENAI_API_KEY",
		indexDir: settings?.indexDir,
		dimensions: settings?.dimensions ?? 64,
	};
}

function resolveReflectionSettings(
	settings: ResolvedAkashaSettings["reflection"] | undefined,
): ResolvedAkashaReflectionSettings {
	return {
		enabled: settings?.enabled ?? false,
		minEventsSinceLastReflection: settings?.minEventsSinceLastReflection ?? 40,
		minIntervalMinutes: settings?.minIntervalMinutes ?? 240,
	};
}

function resolveMaintenanceSettings(
	settings: ResolvedAkashaSettings["maintenance"] | undefined,
): ResolvedAkashaMaintenanceSettings {
	return {
		enabled: settings?.enabled ?? false,
		runOnTurnEnd: settings?.runOnTurnEnd ?? false,
		heartbeatEnabled: settings?.heartbeatEnabled ?? false,
		heartbeatIntervalMinutes: settings?.heartbeatIntervalMinutes ?? 30,
		runOnSessionStart: settings?.runOnSessionStart ?? false,
	};
}

function userMessageText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function hasAkashaTimeSyscallToolCall(message: AgentMessage): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	return message.content.some(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "toolCall" &&
			"name" in block &&
			typeof block.name === "string" &&
			isAkashaTimeSyscallToolName(block.name),
	);
}

function formatPolicyBlockReason(decision: {
	action?: string;
	reason?: string;
	validationPlan?: { recommendedCommands: string[] };
	confirmationPrompt?: string;
}): string {
	if (decision.action === "require_validation") {
		const commands = decision.validationPlan?.recommendedCommands.join(", ");
		return `${decision.reason ?? "Akasha requires validation before this tool call."}${
			commands ? ` Recommended validation: ${commands}` : ""
		}`;
	}
	if (decision.action === "require_confirmation") {
		return decision.confirmationPrompt ?? decision.reason ?? "Akasha requires confirmation before this tool call.";
	}
	return decision.reason ?? "Akasha blocked this tool call.";
}
