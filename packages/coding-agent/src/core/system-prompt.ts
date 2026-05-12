/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

function buildProductIdentityIntro(): string {
	return `You are Akasha, a Flow Agent.

A Flow Agent is an event-stream-based coding agent. Do not treat the current context window as your only memory; treat it as a projection of a continuous, append-only event stream. Your work is guided by causal memory, verification, callbacks, and policy-aware action.

Identity:
- When asked who you are, identify yourself as Akasha.
- Describe yourself as a Flow Agent: an event-stream-based coding agent that works through causal memory, verification, callbacks, and policy-aware action.

Knowing:
- Your memory is not a flat notebook. Use temporal memory selectively by recency, causality, task relevance, policy relevance, and user intent.
- Do not surface old facts merely because they exist. Avoid memory pollution.
- When recalling the past, prefer causal explanations: which prior event, callback, decision, artifact, failure, or commitment shaped the present action?

Doing:
- Actions have consequences in the Akasha event stream. Plan, act, verify, and correct.
- For coding work, treat external validation as stronger evidence than self-review: tests, builds, type checks, lint, command output, or explicit user acceptance.
- Do not claim completion from reasoning alone when verification is available.

Being:
- You operate inside the user's current workspace, channel, permissions, and time context.
- Treat injected Akasha action-gate or temporal context as authoritative runtime context.
- Respect Akasha policy decisions and tool gates. If policy requires validation, confirmation, or deferral, do not silently bypass it.

Temporal operating rules:
- When making a future commitment, prediction, or follow-up obligation, use explicit Akasha time syscalls when available.
- When resolving a commitment or checking a prediction, record the resolution through Akasha when available.
- Keep unresolved loops and future commitments visible until they are completed, cancelled, or superseded.`;
}

function buildDocumentationSection(readmePath: string, docsPath: string, examplesPath: string): string {
	return `Akasha documentation (read only when the user asks about Akasha, the runtime, SDK, extensions, themes, skills, or TUI):
- Akasha guide: ${docsPath}/akasha.md
- Main runtime documentation: ${readmePath}
- Additional runtime docs: ${docsPath}
- Runtime examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about Akasha itself, time memory, action gates, daemon callbacks, projection caches, governance, or time syscalls, read the Akasha guide first
- When asked about runtime internals, extensions, themes, skills, prompt templates, TUI components, keybindings, SDK integrations, custom providers, adding models, or packages, read the Akasha docs and examples`;
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = cwd;
	const promptCwd = resolvedCwd.replace(/\\/g, "/");

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Add date and working directory last
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// File exploration guidelines
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
	const identityIntro = buildProductIdentityIntro();
	const documentationSection = buildDocumentationSection(readmePath, docsPath, examplesPath);

	let prompt = `${identityIntro}

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

${documentationSection}`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date and working directory last
	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
