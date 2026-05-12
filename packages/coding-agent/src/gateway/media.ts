import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { ImageContent } from "@earendil-works/akasha-ai";
import type { AkashaGatewayDownloadedFile } from "./types.js";

const TELEGRAM_TEXT_LIMIT = 4096;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".opus", ".flac", ".aac"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);

export type AkashaGatewayMediaKind = "photo" | "audio" | "video" | "document";

export interface AkashaGatewayMediaReference {
	path: string;
	kind: AkashaGatewayMediaKind;
}

export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		let next = remaining.slice(0, limit);
		const newline = next.lastIndexOf("\n");
		if (newline > 1000) next = next.slice(0, newline);
		chunks.push(next);
		remaining = remaining.slice(next.length).trimStart();
	}
	return chunks.length > 0 ? chunks : [""];
}

export function extractMediaReferences(text: string): { text: string; media: AkashaGatewayMediaReference[] } {
	const media: AkashaGatewayMediaReference[] = [];
	const cleaned = text.replace(/MEDIA:([^\s]+)/g, (_match, path: string) => {
		if (path.startsWith("/")) {
			media.push({ path, kind: classifyMediaPath(path) });
		}
		return "";
	});
	return { text: cleaned.trim(), media };
}

export function classifyMediaPath(path: string): AkashaGatewayMediaKind {
	const ext = extname(path).toLowerCase();
	if (IMAGE_EXTENSIONS.has(ext)) return "photo";
	if (AUDIO_EXTENSIONS.has(ext)) return "audio";
	if (VIDEO_EXTENSIONS.has(ext)) return "video";
	return "document";
}

export function buildPromptFromDownloadedFiles(
	text: string,
	files: AkashaGatewayDownloadedFile[] | undefined,
): { text: string; images: ImageContent[] } {
	const images: ImageContent[] = [];
	const sections = [text];
	for (const file of files ?? []) {
		if (file.kind === "image" && file.mimeType && existsSync(file.path)) {
			images.push({
				type: "image",
				data: readFileSync(file.path).toString("base64"),
				mimeType: file.mimeType,
			});
			sections.push(`[Attached image: ${file.fileName ?? file.path}]`);
			continue;
		}
		if (file.text) {
			sections.push(`Attached file ${file.fileName ?? file.path}:\n\n${file.text}`);
			continue;
		}
		sections.push(`[Attached file: ${file.path}]`);
	}
	return {
		text: sections.filter((part) => part.trim().length > 0).join("\n\n"),
		images,
	};
}

export function validateReadableMediaPath(path: string): { ok: true; size: number } | { ok: false; reason: string } {
	if (!existsSync(path)) return { ok: false, reason: "file does not exist" };
	const stat = statSync(path);
	if (!stat.isFile()) return { ok: false, reason: "path is not a file" };
	return { ok: true, size: stat.size };
}
