import { isAbsolute, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import { deriveOpenLoopEvents } from "./open-loops.js";
import { createAkashaTemporalKernel } from "./temporal-kernel.js";
import { auditAkashaTimeSyscalls, parentFallbacksToAudit } from "./time-syscall-audit.js";
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
	return (pi: ExtensionAPI) => {
		let store: JsonlAkashaStore | undefined;
		let embeddingStore: JsonlAkashaEmbeddingStore | undefined;
		let heartbeat: AkashaHeartbeatController | undefined;
		const embeddingSettings = resolveEmbeddingSettings(options.settings.embedding);
		const reflectionSettings = resolveReflectionSettings(options.settings.reflection);
		const maintenanceSettings = resolveMaintenanceSettings(options.settings.maintenance);
		const privacySettings = options.settings.privacy ?? { redactSecrets: true };
		const embeddingProvider = createAkashaEmbeddingProvider(embeddingSettings);
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
			};
		};

		registerAkashaCommands(pi, getStore, {
			agentDir: options.agentDir,
			eventLogDir: options.settings.eventLogDir,
			reflection: reflectionSettings,
		});

		pi.registerTool({
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

		pi.registerTool({
			name: "akasha_resolve_commitment",
			label: "akasha resolve commitment",
			description: "Resolve an existing Akasha commitment with optional evidence.",
			promptSnippet: "Resolve tracked Akasha commitments with akasha_resolve_commitment.",
			parameters: resolveCommitmentSchema,
			execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
				eventToolResult(appendAkashaCommitmentResolution(syscallContext(ctx, toolCallId), params)),
		});

		pi.registerTool({
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

		pi.registerTool({
			name: "akasha_check_prediction",
			label: "akasha check prediction",
			description: "Check or correct an Akasha prediction with the observed actual outcome.",
			promptSnippet: "Check tracked Akasha predictions with akasha_check_prediction.",
			parameters: checkPredictionSchema,
			execute: async (toolCallId, params, _signal, _onUpdate, ctx) =>
				eventToolResult(appendAkashaPredictionCheck(syscallContext(ctx, toolCallId), params)),
		});

		pi.on("session_start", (event, ctx) => {
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

		pi.on("session_shutdown", (event, ctx) => {
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

		pi.on("agent_start", () => {
			agentRunId = `agent-${uuidv7()}`;
			currentTurnEventId = undefined;
			latestUserEventId = undefined;
			latestAssistantEventId = undefined;
		});

		pi.on("turn_start", (event, ctx) => {
			ensureStore(ctx);
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

		pi.on("turn_end", async (event, ctx) => {
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

		pi.on("message_end", (event, ctx) => {
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
					mode: "soft",
				});
				const auditEvent = audit.audit ? append(audit.audit) : undefined;
				for (const draft of parentFallbacksToAudit(audit.fallbacks, auditEvent?.eventId)) {
					append(draft);
				}
			}
			return undefined;
		});

		pi.on("tool_call", (event, ctx) => {
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
			const requested = append(
				mapToolRequested(event, {
					sessionId: sessionId ?? ctx.sessionManager.getSessionId(),
					streamId,
					eventTime: nowIso(),
					sourceKey: `tool-call:${sessionId}:${event.toolCallId}:requested`,
					parentEventIds,
					correlationId: currentTurnEventId,
				}),
			);
			if (requested) {
				toolRequestEventIds.set(event.toolCallId, requested.eventId);
			}
			return undefined;
		});

		pi.on("tool_result", (event, ctx) => {
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

		pi.on("session_compact", (event, ctx) => {
			ensureStore(ctx);
			reconcileSessionEntry(event.compactionEntry, parents(currentTurnEventId, latestLeafEventId)[0]);
		});

		pi.on("session_tree", (event, ctx) => {
			ensureStore(ctx);
			if (event.summaryEntry) {
				reconcileSessionEntry(event.summaryEntry, parents(currentTurnEventId, latestLeafEventId)[0]);
			}
		});

		pi.on("model_select", (event, ctx) => {
			ensureStore(ctx);
			append(mapModelSelect(event));
		});

		pi.on("thinking_level_select", (event, ctx) => {
			ensureStore(ctx);
			append(mapThinkingLevelSelect(event));
		});

		pi.on("user_bash", (event, ctx) => {
			ensureStore(ctx);
			append(mapUserBash(event));
			return undefined;
		});

		pi.on("context", async (event, ctx) => {
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
					parentEventIds: parents(currentTurnEventId, latestLeafEventId),
					correlationId: currentTurnEventId,
					sourceKey: nextSourceKey("action-gate"),
				});
				const gate = result?.gate;
				if (gate) {
					if (result.auditEvent) latestLeafEventId = result.auditEvent.eventId;
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
