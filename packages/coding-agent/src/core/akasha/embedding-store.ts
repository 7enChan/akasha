import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AkashaEmbeddingRecord {
	id: string;
	targetType: "event" | "crystal";
	targetId: string;
	text: string;
	vector: number[];
	createdAt: string;
}

export interface AkashaEmbeddingTombstone {
	type: "tombstone";
	id: string;
	targetId: string;
	reason: string;
	createdAt: string;
}

export interface AkashaEmbeddingSearchOptions {
	limit: number;
	targetTypes?: Array<"event" | "crystal">;
}

export interface AkashaEmbeddingSearchResult {
	record: AkashaEmbeddingRecord;
	similarity: number;
}

export interface AkashaEmbeddingStore {
	upsert(record: AkashaEmbeddingRecord): Promise<void>;
	search(queryVector: number[], options: AkashaEmbeddingSearchOptions): Promise<AkashaEmbeddingSearchResult[]>;
	has?(id: string): Promise<boolean>;
	list?(): Promise<AkashaEmbeddingRecord[]>;
	tombstone?(targetId: string, reason?: string): Promise<void>;
	purge?(targetId: string): Promise<number>;
	compact?(): Promise<number>;
	listTombstones?(): Promise<AkashaEmbeddingTombstone[]>;
}

export class InMemoryAkashaEmbeddingStore implements AkashaEmbeddingStore {
	private records = new Map<string, AkashaEmbeddingRecord>();
	private tombstones = new Map<string, AkashaEmbeddingTombstone>();

	async upsert(record: AkashaEmbeddingRecord): Promise<void> {
		this.records.set(record.id, record);
	}

	async has(id: string): Promise<boolean> {
		const record = this.records.get(id);
		return !!record && !this.isTombstoned(record);
	}

	async list(): Promise<AkashaEmbeddingRecord[]> {
		return [...this.records.values()].filter((record) => !this.isTombstoned(record));
	}

	async tombstone(targetId: string, reason = "governance"): Promise<void> {
		this.tombstones.set(targetId, createTombstone(targetId, reason));
	}

	async purge(targetId: string): Promise<number> {
		let removed = 0;
		for (const [id, record] of this.records) {
			if (record.id === targetId || record.targetId === targetId) {
				this.records.delete(id);
				removed++;
			}
		}
		this.tombstones.delete(targetId);
		return removed;
	}

	async compact(): Promise<number> {
		let removed = 0;
		for (const [id, record] of this.records) {
			if (this.isTombstoned(record)) {
				this.records.delete(id);
				removed++;
			}
		}
		return removed;
	}

	async listTombstones(): Promise<AkashaEmbeddingTombstone[]> {
		return [...this.tombstones.values()];
	}

	async search(queryVector: number[], options: AkashaEmbeddingSearchOptions): Promise<AkashaEmbeddingSearchResult[]> {
		const targetTypes = options.targetTypes ? new Set(options.targetTypes) : undefined;
		return [...this.records.values()]
			.filter((record) => !this.isTombstoned(record))
			.filter((record) => !targetTypes || targetTypes.has(record.targetType))
			.map((record) => ({
				record,
				similarity: cosineSimilarity(queryVector, record.vector),
			}))
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, options.limit);
	}

	private isTombstoned(record: AkashaEmbeddingRecord): boolean {
		return this.tombstones.has(record.targetId) || this.tombstones.has(record.id);
	}
}

export class JsonlAkashaEmbeddingStore implements AkashaEmbeddingStore {
	readonly path: string;
	private records = new Map<string, AkashaEmbeddingRecord>();
	private tombstones = new Map<string, AkashaEmbeddingTombstone>();

	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true });
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		const content = readFileSync(this.path, "utf-8");
		for (const line of content.split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (isEmbeddingRecord(parsed)) {
					this.records.set(parsed.id, parsed);
				} else if (isEmbeddingTombstone(parsed)) {
					this.tombstones.set(parsed.targetId, parsed);
				}
			} catch {}
		}
	}

	async upsert(record: AkashaEmbeddingRecord): Promise<void> {
		if (this.records.has(record.id)) {
			this.records.set(record.id, record);
			return;
		}
		this.records.set(record.id, record);
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf-8");
	}

	async has(id: string): Promise<boolean> {
		const record = this.records.get(id);
		return !!record && !this.isTombstoned(record);
	}

	async list(): Promise<AkashaEmbeddingRecord[]> {
		return [...this.records.values()].filter((record) => !this.isTombstoned(record));
	}

	async tombstone(targetId: string, reason = "governance"): Promise<void> {
		if (this.tombstones.has(targetId)) return;
		const tombstone = createTombstone(targetId, reason);
		this.tombstones.set(targetId, tombstone);
		appendFileSync(this.path, `${JSON.stringify(tombstone)}\n`, "utf-8");
	}

	async purge(targetId: string): Promise<number> {
		let removed = 0;
		for (const [id, record] of this.records) {
			if (record.id === targetId || record.targetId === targetId) {
				this.records.delete(id);
				removed++;
			}
		}
		this.tombstones.delete(targetId);
		this.rewrite();
		return removed;
	}

	async compact(): Promise<number> {
		let removed = 0;
		for (const [id, record] of this.records) {
			if (this.isTombstoned(record)) {
				this.records.delete(id);
				removed++;
			}
		}
		this.rewrite();
		return removed;
	}

	async listTombstones(): Promise<AkashaEmbeddingTombstone[]> {
		return [...this.tombstones.values()];
	}

	async search(queryVector: number[], options: AkashaEmbeddingSearchOptions): Promise<AkashaEmbeddingSearchResult[]> {
		const targetTypes = options.targetTypes ? new Set(options.targetTypes) : undefined;
		return [...this.records.values()]
			.filter((record) => !this.isTombstoned(record))
			.filter((record) => !targetTypes || targetTypes.has(record.targetType))
			.map((record) => ({
				record,
				similarity: cosineSimilarity(queryVector, record.vector),
			}))
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, options.limit);
	}

	private isTombstoned(record: AkashaEmbeddingRecord): boolean {
		return this.tombstones.has(record.targetId) || this.tombstones.has(record.id);
	}

	private rewrite(): void {
		const lines = [...this.records.values(), ...this.tombstones.values()].map((record) => JSON.stringify(record));
		writeFileSync(this.path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf-8");
	}
}

function isEmbeddingRecord(value: unknown): value is AkashaEmbeddingRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		(record.targetType === "event" || record.targetType === "crystal") &&
		typeof record.targetId === "string" &&
		typeof record.text === "string" &&
		Array.isArray(record.vector) &&
		record.vector.every((item) => typeof item === "number") &&
		typeof record.createdAt === "string"
	);
}

function isEmbeddingTombstone(value: unknown): value is AkashaEmbeddingTombstone {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.type === "tombstone" &&
		typeof record.id === "string" &&
		typeof record.targetId === "string" &&
		typeof record.reason === "string" &&
		typeof record.createdAt === "string"
	);
}

function createTombstone(targetId: string, reason: string): AkashaEmbeddingTombstone {
	return {
		type: "tombstone",
		id: `tombstone:${targetId}`,
		targetId,
		reason,
		createdAt: new Date().toISOString(),
	};
}

function cosineSimilarity(a: number[], b: number[]): number {
	const length = Math.min(a.length, b.length);
	if (length === 0) return 0;
	let dot = 0;
	let aNorm = 0;
	let bNorm = 0;
	for (let index = 0; index < length; index++) {
		const av = a[index] ?? 0;
		const bv = b[index] ?? 0;
		dot += av * bv;
		aNorm += av * av;
		bNorm += bv * bv;
	}
	if (aNorm === 0 || bNorm === 0) return 0;
	return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}
