import type { ResolvedAkashaEmbeddingSettings } from "../settings-manager.js";

export interface AkashaEmbeddingProvider {
	readonly name: string;
	embed(text: string): Promise<number[]>;
}

export class HashAkashaEmbeddingProvider implements AkashaEmbeddingProvider {
	readonly name = "hash";

	constructor(private readonly dimensions = 64) {}

	async embed(text: string): Promise<number[]> {
		const vector = new Array(this.dimensions).fill(0) as number[];
		for (const token of tokenize(text)) {
			const hash = hashString(token);
			const index = Math.abs(hash) % this.dimensions;
			vector[index] += hash < 0 ? -1 : 1;
		}
		return normalize(vector);
	}
}

export interface OpenAICompatibleEmbeddingProviderOptions {
	baseUrl: string;
	model: string;
	apiKey?: string;
	dimensions?: number;
	fetchImpl?: typeof fetch;
}

export class OpenAICompatibleAkashaEmbeddingProvider implements AkashaEmbeddingProvider {
	readonly name = "openai-compatible";
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly options: OpenAICompatibleEmbeddingProviderOptions) {
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async embed(text: string): Promise<number[]> {
		if (!this.options.apiKey) {
			throw new Error("Akasha embedding provider requires an API key.");
		}
		const response = await this.fetchImpl(this.options.baseUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.options.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.options.model,
				input: text,
				...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}),
			}),
		});
		if (!response.ok) {
			throw new Error(`Akasha embedding request failed: ${response.status} ${response.statusText}`);
		}
		const body = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
		const vector = body.data?.[0]?.embedding;
		if (!Array.isArray(vector) || !vector.every((item) => typeof item === "number")) {
			throw new Error("Akasha embedding response did not include a numeric embedding.");
		}
		return vector;
	}
}

export function createAkashaEmbeddingProvider(
	settings: ResolvedAkashaEmbeddingSettings,
	env: NodeJS.ProcessEnv = process.env,
): AkashaEmbeddingProvider | undefined {
	if (!settings.enabled || settings.provider === "off") return undefined;
	if (settings.provider === "hash") {
		return new HashAkashaEmbeddingProvider(settings.dimensions);
	}
	if (settings.provider === "openai-compatible") {
		return new OpenAICompatibleAkashaEmbeddingProvider({
			baseUrl: settings.baseUrl,
			model: settings.model,
			apiKey: env[settings.apiKeyEnv],
			dimensions: settings.dimensions,
		});
	}
	return undefined;
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}_./-]+/u)
		.filter(Boolean);
}

function hashString(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash | 0;
}

function normalize(vector: number[]): number[] {
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	if (norm === 0) return vector;
	return vector.map((value) => value / norm);
}
