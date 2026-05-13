import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { FormData, fetch } from "undici";
import { classifyMediaPath } from "./media.js";

export interface TelegramUser {
	id: number;
	username?: string;
	first_name?: string;
}

export interface TelegramChat {
	id: number;
	type: string;
}

export interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
	width: number;
	height: number;
}

export interface TelegramVoice {
	file_id: string;
	mime_type?: string;
}

export interface TelegramMessage {
	message_id: number;
	date: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	document?: TelegramDocument;
	photo?: TelegramPhotoSize[];
	voice?: TelegramVoice;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface TelegramFile {
	file_id: string;
	file_path?: string;
}

export interface TelegramBotCommand {
	command: string;
	description: string;
}

export class TelegramApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = "TelegramApiError";
	}
}

export interface TelegramClientOptions {
	token: string;
	fetchImpl?: typeof fetch;
}

export class TelegramClient {
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly options: TelegramClientOptions) {
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async getMe(): Promise<TelegramUser> {
		return this.call<TelegramUser>("getMe", {});
	}

	async getUpdates(options: { offset?: number; timeoutSeconds?: number } = {}): Promise<TelegramUpdate[]> {
		return this.call<TelegramUpdate[]>("getUpdates", {
			offset: options.offset,
			timeout: options.timeoutSeconds ?? 30,
			allowed_updates: ["message"],
		});
	}

	async sendMessage(chatId: string | number, text: string): Promise<TelegramMessage> {
		return this.call<TelegramMessage>("sendMessage", {
			chat_id: chatId,
			text,
			disable_web_page_preview: true,
		});
	}

	async sendChatAction(chatId: string | number, action = "typing"): Promise<boolean> {
		return this.call<boolean>("sendChatAction", {
			chat_id: chatId,
			action,
		});
	}

	async setMyCommands(commands: TelegramBotCommand[]): Promise<boolean> {
		return this.call<boolean>("setMyCommands", {
			commands,
		});
	}

	async setWebhook(url: string, secretToken: string): Promise<boolean> {
		return this.call<boolean>("setWebhook", {
			url,
			secret_token: secretToken,
			allowed_updates: ["message"],
		});
	}

	async deleteWebhook(): Promise<boolean> {
		return this.call<boolean>("deleteWebhook", {});
	}

	async getFile(fileId: string): Promise<TelegramFile> {
		return this.call<TelegramFile>("getFile", { file_id: fileId });
	}

	async downloadFile(filePath: string): Promise<Buffer> {
		const response = await this.fetchImpl(this.fileUrl(filePath));
		if (!response.ok) {
			throw new TelegramApiError(`Telegram file download failed: ${response.status}`, response.status);
		}
		return Buffer.from(await response.arrayBuffer());
	}

	async sendMedia(chatId: string | number, filePath: string, caption?: string): Promise<TelegramMessage> {
		const mediaKind = classifyMediaPath(filePath);
		const method =
			mediaKind === "photo"
				? "sendPhoto"
				: mediaKind === "audio"
					? "sendAudio"
					: mediaKind === "video"
						? "sendVideo"
						: "sendDocument";
		const field =
			mediaKind === "photo"
				? "photo"
				: mediaKind === "audio"
					? "audio"
					: mediaKind === "video"
						? "video"
						: "document";
		const form = new FormData();
		form.append("chat_id", String(chatId));
		if (caption) form.append("caption", caption);
		form.append(field, new Blob([readFileSync(filePath)]), basename(filePath));
		return this.call<TelegramMessage>(method, form);
	}

	private async call<T>(method: string, payload: Record<string, unknown> | FormData): Promise<T> {
		const isForm = payload instanceof FormData;
		const response = await this.fetchImpl(this.apiUrl(method), {
			method: "POST",
			headers: isForm ? undefined : { "content-type": "application/json" },
			body: isForm ? payload : JSON.stringify(payload),
		});
		const parsed = (await response.json().catch(() => undefined)) as
			| { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
			| undefined;
		if (!response.ok || !parsed?.ok) {
			throw new TelegramApiError(
				parsed?.description ?? `Telegram API request failed: ${method}`,
				response.status,
				parsed?.parameters?.retry_after,
			);
		}
		return parsed.result as T;
	}

	private apiUrl(method: string): string {
		return `https://api.telegram.org/bot${this.options.token}/${method}`;
	}

	private fileUrl(filePath: string): string {
		return `https://api.telegram.org/file/bot${this.options.token}/${filePath}`;
	}
}
