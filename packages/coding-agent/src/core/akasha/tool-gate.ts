import type { ToolCallEvent } from "../extensions/types.js";
import type { ResolvedAkashaActionGateSettings } from "../settings-manager.js";
import type { AkashaPolicyDecisionAction } from "./policy-kernel.js";
import { evaluateAkashaPolicy } from "./policy-kernel.js";
import type { AkashaEvent } from "./types.js";
import { buildProjectState } from "./world-model.js";

export interface AkashaToolGateDecision {
	allow: boolean;
	action?: AkashaPolicyDecisionAction;
	severity?: "info" | "warning" | "critical";
	rule?: string;
	reason?: string;
	eventIds: string[];
}

export interface AkashaToolGateOptions {
	settings: ResolvedAkashaActionGateSettings;
	timelineEvents: AkashaEvent[];
}

export function evaluateAkashaToolGate(event: ToolCallEvent, options: AkashaToolGateOptions): AkashaToolGateDecision {
	if (!options.settings.enforceToolGate) return allowDecision();

	if (event.toolName === "bash" && options.settings.blockDestructiveCommands) {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const match = findDangerousCommandPattern(command);
		if (match) {
			return fromPolicyDecision(
				evaluateAkashaPolicy({
					actionType: "tool_call",
					subject: event.toolName,
					objectId: command,
					payload: { dangerousCommandLabel: match.label },
					rules: [
						{
							id: "destructive_command",
							description: "Block high-risk destructive shell commands.",
							severity: "critical",
						},
					],
				}),
			);
		}
	}

	if (options.settings.blockUnverifiedArtifactWrites && isArtifactMutation(event)) {
		const targetPath = toolPath(event);
		const state = buildProjectState(options.timelineEvents);
		const unverified = state.activeFiles.filter((file) => file.status === "modified_unverified");
		const wideningChange = unverified.length > 0 && !unverified.some((file) => file.path === targetPath);
		if (wideningChange) {
			const byId = new Map(options.timelineEvents.map((timelineEvent) => [timelineEvent.eventId, timelineEvent]));
			return fromPolicyDecision(
				evaluateAkashaPolicy({
					actionType: "tool_call",
					subject: event.toolName,
					objectId: targetPath,
					evidenceEvents: unverified.flatMap((file) => {
						const evidence = byId.get(file.lastEventId);
						return evidence ? [evidence] : [];
					}),
					rules: [
						{
							id: "unverified_artifact_widening",
							description: "Require validation before widening edits to another artifact.",
							severity: "warning",
						},
					],
				}),
			);
		}
	}

	return allowDecision();
}

export function findDangerousCommandPattern(command: string): { label: string } | undefined {
	const normalized = command.toLowerCase();
	for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
		if (pattern.regex.test(normalized)) return { label: pattern.label };
	}
	return undefined;
}

function allowDecision(): AkashaToolGateDecision {
	return { allow: true, action: "allow", severity: "info", eventIds: [] };
}

function fromPolicyDecision(decision: ReturnType<typeof evaluateAkashaPolicy>): AkashaToolGateDecision {
	return {
		allow: decision.action === "allow",
		action: decision.action,
		severity: decision.severity,
		rule: decision.ruleId,
		reason: decision.reason,
		eventIds: decision.evidenceEventIds,
	};
}

function isArtifactMutation(event: ToolCallEvent): boolean {
	return event.toolName === "edit" || event.toolName === "write";
}

function toolPath(event: ToolCallEvent): string | undefined {
	if ("path" in event.input && typeof event.input.path === "string") return event.input.path;
	if ("file_path" in event.input && typeof event.input.file_path === "string") return event.input.file_path;
	return undefined;
}

const DANGEROUS_COMMAND_PATTERNS: Array<{ label: string; regex: RegExp }> = [
	{ label: "recursive forced remove", regex: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\b|\brm\s+-[a-z]*f[a-z]*r[a-z]*\b/ },
	{ label: "git reset hard", regex: /\bgit\s+reset\s+--hard\b/ },
	{
		label: "git clean force",
		regex: /\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*\b|\bgit\s+clean\s+-[a-z]*d[a-z]*f[a-z]*\b/,
	},
	{ label: "force push", regex: /\bgit\s+push\b[^\n;|&]*\s--force(?:-with-lease)?\b/ },
	{ label: "sudo command", regex: /\bsudo\s+/ },
	{ label: "world-writable chmod", regex: /\bchmod\s+-r\s+777\b|\bchmod\s+777\s+-r\b|\bchmod\s+-R\s+777\b/ },
	{ label: "curl pipe shell", regex: /\bcurl\b[^\n]*\|\s*(?:sh|bash)\b/ },
	{ label: "wget pipe shell", regex: /\bwget\b[^\n]*\|\s*(?:sh|bash)\b/ },
	{ label: "npm publish", regex: /\bnpm\s+publish\b/ },
	{ label: "GitHub PR merge", regex: /\bgh\s+pr\s+merge\b/ },
];
