import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { AkashaGatewayLogger } from "./logger.js";
import { TelegramApiError, type TelegramClient, type TelegramMessage, type TelegramUpdate } from "./telegram-client.js";
import type {
	AkashaGatewayCommandMenuItem,
	AkashaGatewayConfig,
	AkashaGatewayDownloadedFile,
	AkashaGatewayMessageHandler,
} from "./types.js";

export interface TelegramGatewayAdapterOptions {
	config: AkashaGatewayConfig;
	client: TelegramClient;
	handler: AkashaGatewayMessageHandler;
	logger: AkashaGatewayLogger;
	initialOffset?: number;
}

export class TelegramGatewayAdapter {
	readonly name = "telegram" as const;
	private stopped = false;
	private offset: number | undefined;
	private server: Server | undefined;

	constructor(private readonly options: TelegramGatewayAdapterOptions) {
		this.offset = options.initialOffset;
	}

	async start(): Promise<void> {
		if (this.options.config.telegram.mode === "webhook") {
			await this.startWebhook();
			return;
		}
		await this.startPolling();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.server) {
			await new Promise<void>((resolve) => this.server?.close(() => resolve()));
			this.server = undefined;
		}
	}

	async sendMessage(message: { chatId: string; text: string }): Promise<void> {
		await this.options.client.sendMessage(message.chatId, message.text);
	}

	async sendChatAction(chatId: string, action: "typing" = "typing"): Promise<void> {
		await this.options.client.sendChatAction(chatId, action);
	}

	async setCommands(commands: AkashaGatewayCommandMenuItem[]): Promise<void> {
		await this.options.client.setMyCommands(commands);
	}

	async sendMedia(chatId: string, filePath: string, caption?: string): Promise<void> {
		await this.options.client.sendMedia(chatId, filePath, caption);
	}

	async handleUpdate(update: TelegramUpdate): Promise<void> {
		this.offset = update.update_id + 1;
		if (!update.message) return;
		const message = update.message;
		const text = message.text ?? message.caption ?? "";
		const files = await this.downloadMessageFiles(message);
		await this.options.handler.handle({
			platform: "telegram",
			chatId: String(message.chat.id),
			messageId: String(message.message_id),
			userId: message.from?.id,
			username: message.from?.username,
			text,
			files,
			updateId: update.update_id,
			receivedTime: new Date((message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
			raw: sanitizeTelegramUpdate(update),
		});
	}

	private async startPolling(): Promise<void> {
		await this.options.client.deleteWebhook().catch(() => undefined);
		this.options.logger.info("Telegram gateway connected in polling mode");
		let backoffMs = 1000;
		while (!this.stopped) {
			try {
				const updates = await this.options.client.getUpdates({ offset: this.offset, timeoutSeconds: 30 });
				for (const update of updates) {
					await this.handleUpdate(update);
				}
				backoffMs = 1000;
			} catch (error) {
				const delay = retryDelayMs(error, backoffMs);
				this.options.logger.warn(`Telegram polling failed; retrying in ${delay}ms: ${errorMessage(error)}`);
				await sleep(delay);
				backoffMs = Math.min(delay * 2, 30000);
			}
		}
	}

	private async startWebhook(): Promise<void> {
		const { webhookUrl, webhookSecret, webhookPort } = this.options.config.telegram;
		if (!webhookUrl || !webhookSecret) {
			throw new Error("Telegram webhook mode requires TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET");
		}
		const url = new URL(webhookUrl);
		await this.options.client.setWebhook(webhookUrl, webhookSecret);
		this.server = createServer((req, res) => {
			void this.handleWebhookRequest(req, res, url.pathname || "/", webhookSecret);
		});
		await new Promise<void>((resolve) => this.server?.listen(webhookPort, resolve));
		this.options.logger.info(`Telegram gateway connected in webhook mode on port ${webhookPort}`);
		await new Promise<void>((resolve) => {
			this.server?.once("close", () => resolve());
		});
	}

	private async handleWebhookRequest(
		req: IncomingMessage,
		res: ServerResponse,
		pathname: string,
		secret: string,
	): Promise<void> {
		if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== pathname) {
			res.writeHead(404).end();
			return;
		}
		if (req.headers["x-telegram-bot-api-secret-token"] !== secret) {
			res.writeHead(401).end();
			return;
		}
		try {
			const body = await readRequestBody(req);
			await this.handleUpdate(JSON.parse(body) as TelegramUpdate);
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
		} catch (error) {
			this.options.logger.error(`Telegram webhook update failed: ${errorMessage(error)}`);
			res.writeHead(500).end();
		}
	}

	private async downloadMessageFiles(message: TelegramMessage): Promise<AkashaGatewayDownloadedFile[]> {
		const files: AkashaGatewayDownloadedFile[] = [];
		if (message.document) {
			files.push(
				await this.downloadTelegramFile({
					fileId: message.document.file_id,
					fileName: message.document.file_name,
					mimeType: message.document.mime_type,
					kind: "document",
				}),
			);
		}
		if (message.photo?.length) {
			const photo = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
			files.push(await this.downloadTelegramFile({ fileId: photo.file_id, mimeType: "image/jpeg", kind: "image" }));
		}
		if (message.voice) {
			files.push(
				await this.downloadTelegramFile({
					fileId: message.voice.file_id,
					mimeType: message.voice.mime_type,
					kind: "voice",
				}),
			);
		}
		return files;
	}

	private async downloadTelegramFile(input: {
		fileId: string;
		fileName?: string;
		mimeType?: string;
		kind: AkashaGatewayDownloadedFile["kind"];
	}): Promise<AkashaGatewayDownloadedFile> {
		const file = await this.options.client.getFile(input.fileId);
		const filePath = file.file_path ?? input.fileName ?? input.fileId;
		const bytes = file.file_path ? await this.options.client.downloadFile(file.file_path) : Buffer.alloc(0);
		const ext = extname(input.fileName ?? filePath) || extensionFromMime(input.mimeType);
		const localName = `${Date.now()}-${input.fileId}${ext}`;
		const localPath = join(this.options.config.agentDir, "gateway", "telegram", "files", localName);
		mkdirSync(join(this.options.config.agentDir, "gateway", "telegram", "files"), { recursive: true });
		writeFileSync(localPath, bytes);
		const downloaded: AkashaGatewayDownloadedFile = {
			fileId: input.fileId,
			path: localPath,
			mimeType: input.mimeType,
			fileName: input.fileName,
			kind: input.kind,
		};
		if (isTextMime(input.mimeType) && bytes.length <= 200_000) {
			downloaded.text = bytes.toString("utf-8");
		}
		return downloaded;
	}
}

function retryDelayMs(error: unknown, fallback: number): number {
	if (error instanceof TelegramApiError && error.retryAfterSeconds) {
		return Math.max(1000, error.retryAfterSeconds * 1000);
	}
	return fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRequestBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf-8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

function sanitizeTelegramUpdate(update: TelegramUpdate): unknown {
	return update;
}

function isTextMime(mimeType: string | undefined): boolean {
	return !!mimeType && (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+json"));
}

function extensionFromMime(mimeType: string | undefined): string {
	if (mimeType === "image/png") return ".png";
	if (mimeType === "image/jpeg") return ".jpg";
	if (mimeType === "text/plain") return ".txt";
	if (mimeType === "application/json") return ".json";
	return "";
}
