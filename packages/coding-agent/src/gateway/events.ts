import { join } from "node:path";
import { resolveAkashaEventLogPath } from "../core/akasha/collector-extension.js";
import { JsonlAkashaStore } from "../core/akasha/jsonl-store.js";
import type { AkashaEvent, AkashaEventDraft, AkashaEventKind } from "../core/akasha/types.js";
import type { ResolvedAkashaSettings } from "../core/settings-manager.js";
import type { AkashaGatewayChatState, AkashaGatewayPlatform } from "./types.js";

export interface AkashaGatewayEventWriterOptions {
	agentDir: string;
	settings: Pick<ResolvedAkashaSettings, "eventLogDir" | "privacy">;
}

export class AkashaGatewayEventWriter {
	constructor(private readonly options: AkashaGatewayEventWriterOptions) {}

	appendForChat(
		chat: Pick<AkashaGatewayChatState, "platform" | "chatId" | "cwd">,
		event: Omit<AkashaEventDraft, "sessionId" | "streamId" | "eventTime" | "actor"> & {
			kind: AkashaEventKind;
			eventTime?: string;
			actor?: AkashaEventDraft["actor"];
		},
	): AkashaEvent {
		const sessionId = `gateway:${chat.platform}:${chat.chatId}`;
		return this.storeForSession(sessionId).append({
			sessionId,
			streamId: `gateway:${chat.platform}:${chat.chatId}`,
			eventTime: event.eventTime ?? new Date().toISOString(),
			actor: event.actor ?? "system",
			...event,
			payload: {
				platform: chat.platform,
				chatId: chat.chatId,
				cwd: chat.cwd,
				...(event.payload ?? {}),
			},
		});
	}

	appendGateway(
		platform: AkashaGatewayPlatform,
		event: Omit<AkashaEventDraft, "sessionId" | "streamId" | "eventTime" | "actor"> & {
			kind: AkashaEventKind;
			eventTime?: string;
			actor?: AkashaEventDraft["actor"];
		},
	): AkashaEvent {
		const sessionId = `gateway:${platform}`;
		return this.storeForSession(sessionId).append({
			sessionId,
			streamId: `gateway:${platform}`,
			eventTime: event.eventTime ?? new Date().toISOString(),
			actor: event.actor ?? "system",
			...event,
			payload: {
				platform,
				...(event.payload ?? {}),
			},
		});
	}

	private storeForSession(sessionId: string): JsonlAkashaStore {
		const safeSessionId = sessionId.replace(/[^A-Za-z0-9_.:-]/g, "_");
		const path = this.options.settings.eventLogDir
			? resolveAkashaEventLogPath(this.options.settings, this.options.agentDir, safeSessionId)
			: join(this.options.agentDir, "akasha", "events", `${safeSessionId}.jsonl`);
		return new JsonlAkashaStore(path, {
			redactSecrets: this.options.settings.privacy.redactSecrets,
		});
	}
}
