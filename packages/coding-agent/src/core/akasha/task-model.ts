import { buildArtifactStates } from "./artifact-state.js";
import { buildKarmaLedger } from "./karma-ledger.js";
import { buildOpenLoopLedger } from "./open-loops.js";
import { orderAkashaEvents } from "./ordering.js";
import type { AkashaEvent } from "./types.js";

export interface AkashaGoalState {
	goalId: string;
	text: string;
	status: "active" | "superseded";
	eventId: string;
	eventTime: string;
}

export interface AkashaTaskState {
	taskId: string;
	text: string;
	status: "open" | "overdue" | "resolved" | "blocked";
	eventId: string;
	eventTime: string;
	dueTime?: string;
}

export interface AkashaDecisionState {
	decisionId: string;
	text: string;
	eventId: string;
	eventTime: string;
	kind: AkashaEvent["kind"];
}

export interface AkashaRiskState {
	riskId: string;
	reason: string;
	severity: "medium" | "high" | "critical";
	text: string;
	eventId: string;
	eventTime: string;
	objectId?: string;
}

export type AkashaTaskGraphNodeType = "goal" | "task" | "decision" | "risk" | "artifact" | "callback";

export type AkashaTaskGraphEdgeType = "belongs_to" | "blocks" | "caused_by" | "tracks" | "validates" | "references";

export interface AkashaCallbackState {
	callbackId: string;
	status: "scheduled" | "due" | "completed" | "cancelled";
	text: string;
	eventId: string;
	eventTime: string;
	targetEventId?: string;
	dueTime?: string;
}

export interface AkashaTaskGraphNode {
	id: string;
	type: AkashaTaskGraphNodeType;
	label: string;
	eventId: string;
	eventTime: string;
	status?: string;
	objectId?: string;
}

export interface AkashaTaskGraphEdge {
	from: string;
	to: string;
	type: AkashaTaskGraphEdgeType;
	eventId?: string;
	reason?: string;
}

export interface AkashaTaskGraph {
	nodes: AkashaTaskGraphNode[];
	edges: AkashaTaskGraphEdge[];
}

export interface AkashaTaskModel {
	goals: AkashaGoalState[];
	tasks: AkashaTaskState[];
	decisions: AkashaDecisionState[];
	risks: AkashaRiskState[];
	callbacks: AkashaCallbackState[];
	graph: AkashaTaskGraph;
	lastEventId?: string;
	lastEventTime?: string;
}

export function buildAkashaTaskModel(events: AkashaEvent[]): AkashaTaskModel {
	const ordered = orderAkashaEvents(events);
	const goals = extractGoals(ordered);
	const ledger = buildKarmaLedger(ordered);
	const loops = buildOpenLoopLedger(ordered);
	const artifacts = buildArtifactStates(ordered);
	const lastEvent = ordered.at(-1);
	const tasks: AkashaTaskState[] = [
		...ledger.promises.map((promise) => ({
			taskId: promise.promiseId,
			text: promise.summary,
			status: promise.state,
			eventId: promise.lastEventId,
			eventTime: promise.lastEventTime,
			dueTime: promise.dueTime,
		})),
		...loops
			.filter((loop) => loop.state !== "resolved")
			.map((loop) => ({
				taskId: loop.loopKey,
				text: loop.summary,
				status: loop.state === "blocked" ? ("blocked" as const) : ("open" as const),
				eventId: loop.openedEventId ?? loop.rootEventId,
				eventTime: eventTime(ordered, loop.openedEventId ?? loop.rootEventId),
			})),
	];
	const decisions = extractDecisions(ordered);
	const risks: AkashaRiskState[] = [
		...ordered.flatMap(toolBlockedRisk),
		...artifacts
			.filter((artifact) => artifact.status === "modified_unverified" || artifact.status === "failed")
			.map((artifact) => ({
				riskId: `artifact:${artifact.path}:${artifact.status}`,
				reason: artifact.status,
				severity: artifact.status === "failed" ? ("high" as const) : ("medium" as const),
				text:
					artifact.status === "failed"
						? `${artifact.path} has a failed artifact operation`
						: `${artifact.path} was modified without later validation`,
				eventId: artifact.lastEventId,
				eventTime: artifact.lastEventTime,
				objectId: artifact.path,
			})),
	];
	const callbacks = extractCallbacks(ordered);

	return {
		goals,
		tasks,
		decisions,
		risks,
		callbacks,
		graph: buildTaskGraph({ goals, tasks, decisions, risks, callbacks, artifacts }),
		lastEventId: lastEvent?.eventId,
		lastEventTime: lastEvent?.eventTime,
	};
}

function extractGoals(events: AkashaEvent[]): AkashaGoalState[] {
	const goalEvents = events.filter(
		(event) => event.kind === "message.user.submitted" && looksLikeGoal(eventText(event)),
	);
	return goalEvents
		.map((event, index) => ({
			goalId: event.eventId,
			text: eventText(event),
			status: index === goalEvents.length - 1 ? ("active" as const) : ("superseded" as const),
			eventId: event.eventId,
			eventTime: event.eventTime,
		}))
		.reverse();
}

function extractDecisions(events: AkashaEvent[]): AkashaDecisionState[] {
	return events
		.filter(isDecisionEvent)
		.map((event) => ({
			decisionId: event.eventId,
			text: eventText(event),
			eventId: event.eventId,
			eventTime: event.eventTime,
			kind: event.kind,
		}))
		.slice(-12)
		.reverse();
}

function toolBlockedRisk(event: AkashaEvent): AkashaRiskState[] {
	if (event.kind !== "tool.blocked") return [];
	const severity = event.payload.rule === "destructive_command" ? "critical" : "high";
	return [
		{
			riskId: `blocked:${event.eventId}`,
			reason: typeof event.payload.rule === "string" ? event.payload.rule : "tool_blocked",
			severity,
			text: typeof event.payload.reason === "string" ? event.payload.reason : "Tool call blocked by Akasha",
			eventId: event.eventId,
			eventTime: event.eventTime,
			objectId: event.objectId,
		},
	];
}

function extractCallbacks(events: AkashaEvent[]): AkashaCallbackState[] {
	const callbacks = new Map<string, AkashaCallbackState>();
	for (const event of events) {
		if (
			event.kind !== "time.callback.scheduled" &&
			event.kind !== "time.callback.due" &&
			event.kind !== "time.callback.completed" &&
			event.kind !== "time.callback.cancelled"
		) {
			continue;
		}
		const callbackId = typeof event.payload.callbackId === "string" ? event.payload.callbackId : event.eventId;
		callbacks.set(callbackId, {
			callbackId,
			status: callbackStatus(event.kind),
			text: eventText(event) || callbackId,
			eventId: event.eventId,
			eventTime: event.eventTime,
			targetEventId: typeof event.payload.targetEventId === "string" ? event.payload.targetEventId : event.objectId,
			dueTime: typeof event.payload.dueTime === "string" ? event.payload.dueTime : undefined,
		});
	}
	return [...callbacks.values()].sort((a, b) => b.eventTime.localeCompare(a.eventTime));
}

function callbackStatus(kind: AkashaEvent["kind"]): AkashaCallbackState["status"] {
	if (kind === "time.callback.completed") return "completed";
	if (kind === "time.callback.cancelled") return "cancelled";
	if (kind === "time.callback.due") return "due";
	return "scheduled";
}

function buildTaskGraph(input: {
	goals: AkashaGoalState[];
	tasks: AkashaTaskState[];
	decisions: AkashaDecisionState[];
	risks: AkashaRiskState[];
	callbacks: AkashaCallbackState[];
	artifacts: ReturnType<typeof buildArtifactStates>;
}): AkashaTaskGraph {
	const nodes: AkashaTaskGraphNode[] = [];
	const edges: AkashaTaskGraphEdge[] = [];
	const addNode = (node: AkashaTaskGraphNode): void => {
		if (!nodes.some((existing) => existing.id === node.id)) nodes.push(node);
	};
	const addEdge = (edge: AkashaTaskGraphEdge): void => {
		if (!edges.some((existing) => sameEdge(existing, edge))) edges.push(edge);
	};

	for (const goal of input.goals) {
		addNode({
			id: nodeId("goal", goal.goalId),
			type: "goal",
			label: goal.text,
			eventId: goal.eventId,
			eventTime: goal.eventTime,
			status: goal.status,
		});
	}

	for (const task of input.tasks) {
		addNode({
			id: nodeId("task", task.taskId),
			type: "task",
			label: task.text,
			eventId: task.eventId,
			eventTime: task.eventTime,
			status: task.status,
		});
		const goal = nearestGoal(input.goals, task.eventTime);
		if (goal) {
			addEdge({
				from: nodeId("task", task.taskId),
				to: nodeId("goal", goal.goalId),
				type: "belongs_to",
				eventId: task.eventId,
				reason: "task follows the active goal at its event time",
			});
		}
	}

	for (const artifact of input.artifacts) {
		addNode({
			id: nodeId("artifact", artifact.path),
			type: "artifact",
			label: artifact.path,
			eventId: artifact.lastEventId,
			eventTime: artifact.lastEventTime,
			status: artifact.status,
			objectId: artifact.path,
		});
		for (const task of input.tasks.filter((task) => textReferences(task.text, artifact.path))) {
			addEdge({
				from: nodeId("task", task.taskId),
				to: nodeId("artifact", artifact.path),
				type: "references",
				eventId: task.eventId,
				reason: "task text references artifact",
			});
		}
	}

	for (const risk of input.risks) {
		addNode({
			id: nodeId("risk", risk.riskId),
			type: "risk",
			label: risk.text,
			eventId: risk.eventId,
			eventTime: risk.eventTime,
			status: risk.severity,
			objectId: risk.objectId,
		});
		if (risk.objectId && input.artifacts.some((artifact) => artifact.path === risk.objectId)) {
			addEdge({
				from: nodeId("risk", risk.riskId),
				to: nodeId("artifact", risk.objectId),
				type: "blocks",
				eventId: risk.eventId,
				reason: risk.reason,
			});
		}
		for (const task of input.tasks.filter((task) => !risk.objectId || textReferences(task.text, risk.objectId))) {
			addEdge({
				from: nodeId("risk", risk.riskId),
				to: nodeId("task", task.taskId),
				type: "blocks",
				eventId: risk.eventId,
				reason: risk.reason,
			});
		}
	}

	for (const decision of input.decisions) {
		addNode({
			id: nodeId("decision", decision.decisionId),
			type: "decision",
			label: decision.text,
			eventId: decision.eventId,
			eventTime: decision.eventTime,
			status: decision.kind,
		});
		const goal = nearestGoal(input.goals, decision.eventTime);
		if (goal) {
			addEdge({
				from: nodeId("decision", decision.decisionId),
				to: nodeId("goal", goal.goalId),
				type: "belongs_to",
				eventId: decision.eventId,
			});
		}
		for (const artifact of input.artifacts.filter((artifact) => textReferences(decision.text, artifact.path))) {
			addEdge({
				from: nodeId("decision", decision.decisionId),
				to: nodeId("artifact", artifact.path),
				type: "references",
				eventId: decision.eventId,
			});
		}
	}

	for (const callback of input.callbacks) {
		addNode({
			id: nodeId("callback", callback.callbackId),
			type: "callback",
			label: callback.text,
			eventId: callback.eventId,
			eventTime: callback.eventTime,
			status: callback.status,
		});
		const targetTask = input.tasks.find(
			(task) => task.eventId === callback.targetEventId || task.taskId === callback.targetEventId,
		);
		if (targetTask) {
			addEdge({
				from: nodeId("callback", callback.callbackId),
				to: nodeId("task", targetTask.taskId),
				type: "tracks",
				eventId: callback.eventId,
			});
		}
		const targetArtifact = input.artifacts.find((artifact) => artifact.lastEventId === callback.targetEventId);
		if (targetArtifact) {
			addEdge({
				from: nodeId("callback", callback.callbackId),
				to: nodeId("artifact", targetArtifact.path),
				type: "tracks",
				eventId: callback.eventId,
			});
		}
	}

	for (const artifact of input.artifacts) {
		if (artifact.lastValidationEventId) {
			const validationNodeId = nodeId("decision", artifact.lastValidationEventId);
			addNode({
				id: validationNodeId,
				type: "decision",
				label: `Validation for ${artifact.path}`,
				eventId: artifact.lastValidationEventId,
				eventTime: artifact.lastEventTime,
				status: "validation",
				objectId: artifact.path,
			});
			addEdge({
				from: validationNodeId,
				to: nodeId("artifact", artifact.path),
				type: "validates",
				eventId: artifact.lastValidationEventId,
			});
		}
	}

	return { nodes, edges };
}

function nearestGoal(goals: AkashaGoalState[], eventTime: string): AkashaGoalState | undefined {
	return goals.filter((goal) => goal.eventTime <= eventTime).sort((a, b) => b.eventTime.localeCompare(a.eventTime))[0];
}

function nodeId(type: AkashaTaskGraphNodeType, id: string): string {
	return `${type}:${id}`;
}

function sameEdge(a: AkashaTaskGraphEdge, b: AkashaTaskGraphEdge): boolean {
	return a.from === b.from && a.to === b.to && a.type === b.type && a.eventId === b.eventId;
}

function textReferences(text: string, path: string): boolean {
	const normalizedText = text.toLowerCase();
	const normalizedPath = path.toLowerCase();
	const basename = normalizedPath.split("/").pop() ?? normalizedPath;
	return normalizedText.includes(normalizedPath) || normalizedText.includes(basename);
}

function eventTime(events: AkashaEvent[], eventId: string): string {
	return events.find((event) => event.eventId === eventId)?.eventTime ?? new Date(0).toISOString();
}

function looksLikeGoal(text: string): boolean {
	const lower = text.toLowerCase();
	return (
		lower.includes("goal") ||
		lower.includes("plan") ||
		lower.includes("implement") ||
		lower.includes("build") ||
		text.includes("目标") ||
		text.includes("计划") ||
		text.includes("实现") ||
		text.includes("开发")
	);
}

function isDecisionEvent(event: AkashaEvent): boolean {
	if (
		event.kind === "message.agent.completed" ||
		event.kind === "branch.summary_created" ||
		event.kind === "failure.lesson_learned" ||
		event.kind === "workflow.optimized" ||
		event.kind === "policy.evaluated"
	) {
		return eventText(event).length > 0;
	}
	return false;
}

function eventText(event: AkashaEvent): string {
	const payload = event.payload;
	if (typeof payload.text === "string") return payload.text;
	if (typeof payload.summary === "string") return payload.summary;
	if (typeof payload.reason === "string") return payload.reason;
	if (typeof payload.lesson === "string") return payload.lesson;
	return "";
}
