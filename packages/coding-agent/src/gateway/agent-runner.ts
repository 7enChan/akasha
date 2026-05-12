import type { AssistantMessage } from "@earendil-works/akasha-ai";
import { emitSessionShutdownEvent } from "../core/extensions/runner.js";
import { createAgentSession } from "../core/sdk.js";
import { SessionManager } from "../core/session-manager.js";
import { buildPromptFromDownloadedFiles } from "./media.js";
import type { AkashaGatewayAgentResult, AkashaGatewayAgentRunInput, AkashaGatewayAgentRunner } from "./types.js";

export interface DefaultAkashaGatewayAgentRunnerOptions {
	agentDir: string;
}

export class DefaultAkashaGatewayAgentRunner implements AkashaGatewayAgentRunner {
	private readonly active = new Map<string, { abort: () => Promise<void> }>();

	constructor(private readonly options: DefaultAkashaGatewayAgentRunnerOptions) {}

	async run(input: AkashaGatewayAgentRunInput): Promise<AkashaGatewayAgentResult> {
		const sessionManager = SessionManager.continueRecent(input.chat.cwd, input.chat.sessionDir);
		const created = await createAgentSession({
			cwd: input.chat.cwd,
			agentDir: this.options.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume" },
		});
		const session = created.session;
		this.active.set(input.chat.chatId, { abort: () => session.abort() });
		try {
			await session.bindExtensions({
				onError: (error) => {
					console.error(`Gateway extension error (${error.extensionPath}): ${error.error}`);
				},
			});
			const prompt = buildPromptFromDownloadedFiles(input.message.text, input.message.files);
			const images = [...(input.message.images ?? []), ...prompt.images];
			await session.prompt(prompt.text || "Please review the attached input.", {
				images: images.length > 0 ? images : undefined,
				expandPromptTemplates: false,
				source: "extension",
			});
			const text = extractLastAssistantText(session.state.messages);
			return {
				text: text || "(Akasha completed without a text response.)",
				sessionId: session.sessionManager.getSessionId(),
				sessionFile: session.sessionManager.getSessionFile(),
			};
		} finally {
			this.active.delete(input.chat.chatId);
			await emitSessionShutdownEvent(session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			}).catch(() => undefined);
			session.dispose();
		}
	}

	async stop(chatId: string): Promise<boolean> {
		const active = this.active.get(chatId);
		if (!active) return false;
		await active.abort();
		return true;
	}
}

function extractLastAssistantText(messages: unknown[]): string {
	const lastAssistant = [...messages].reverse().find(isAssistantMessage);
	if (!lastAssistant) return "";
	return lastAssistant.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	if (typeof value !== "object" || value === null) return false;
	const record = value as { role?: unknown; content?: unknown };
	return record.role === "assistant" && Array.isArray(record.content);
}
