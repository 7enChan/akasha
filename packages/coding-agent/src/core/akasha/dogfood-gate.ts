import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	type AkashaDogfoodMemoryEvalBudget,
	type AkashaDogfoodMemoryEvalCorpus,
	type AkashaDogfoodMemoryEvalResult,
	runAkashaDogfoodMemoryEval,
} from "./dogfood-memory-eval.js";
import type { AkashaLongitudinalMemoryEvalCase } from "./longitudinal-memory-eval.js";
import type { AkashaSemanticMemorySeed } from "./semantic-memory-seed.js";
import type { AkashaStore } from "./types.js";

export interface AkashaDogfoodGateOptions {
	name?: string;
	cwd?: string;
	now?: Date | string;
	corpusPath?: string;
	stores?: AkashaStore[];
	defaultBudget?: AkashaDogfoodMemoryEvalBudget;
	defaultLimit?: number;
	maxTraces?: number;
}

export interface AkashaDogfoodCorpusSpec {
	name: string;
	eventLogPaths?: string[];
	cases: AkashaLongitudinalMemoryEvalCase[];
	cwd?: string;
	now?: Date | string;
	defaultLimit?: number;
	maxTraces?: number;
	budget?: AkashaDogfoodMemoryEvalBudget;
	semanticSeedsByQuery?: Record<string, AkashaSemanticMemorySeed[]>;
}

export function runAkashaDogfoodGate(options: AkashaDogfoodGateOptions): AkashaDogfoodMemoryEvalResult {
	const corpus = options.corpusPath
		? loadAkashaDogfoodCorpusSpec(options.corpusPath)
		: createAkashaDogfoodCorpusFromStores(options.name ?? "akasha dogfood runtime logs", options.stores ?? [], {
				cwd: options.cwd,
				now: options.now,
				budget: options.defaultBudget,
				defaultLimit: options.defaultLimit,
				maxTraces: options.maxTraces,
			});
	return runAkashaDogfoodMemoryEval([corpus], {
		cwd: options.cwd,
		now: options.now,
		defaultBudget: options.defaultBudget,
		defaultLimit: options.defaultLimit,
		maxTraces: options.maxTraces,
	});
}

export function loadAkashaDogfoodCorpusSpec(path: string): AkashaDogfoodMemoryEvalCorpus {
	const specDir = dirname(path);
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!isCorpusSpec(parsed)) {
		throw new Error(`Invalid Akasha dogfood corpus spec: ${path}`);
	}
	return {
		name: parsed.name,
		eventLogPaths: (parsed.eventLogPaths ?? []).map((eventLogPath) =>
			isAbsolute(eventLogPath) ? eventLogPath : resolve(specDir, eventLogPath),
		),
		cases: parsed.cases,
		cwd: parsed.cwd,
		now: parsed.now,
		defaultLimit: parsed.defaultLimit,
		maxTraces: parsed.maxTraces,
		budget: parsed.budget,
		semanticSeeds: (queryText) => parsed.semanticSeedsByQuery?.[queryText ?? ""] ?? [],
	};
}

export function createAkashaDogfoodCorpusFromStores(
	name: string,
	stores: AkashaStore[],
	options: {
		cwd?: string;
		now?: Date | string;
		budget?: AkashaDogfoodMemoryEvalBudget;
		defaultLimit?: number;
		maxTraces?: number;
	} = {},
): AkashaDogfoodMemoryEvalCorpus {
	return {
		name,
		events: stores.flatMap((store) => store.buildTimeline({ limit: 2_000 })),
		cases: [
			{
				name: "runtime event-log budget gate",
				queryText: "akasha runtime dogfood gate",
				limit: 8,
			},
		],
		cwd: options.cwd,
		now: options.now,
		defaultLimit: options.defaultLimit,
		maxTraces: options.maxTraces,
		budget: {
			maxParseIssues: 0,
			maxDurationMs: 10_000,
			maxEstimatedActionGateTokens: 4_000,
			...options.budget,
		},
	};
}

function isCorpusSpec(value: unknown): value is AkashaDogfoodCorpusSpec {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string") return false;
	if (!Array.isArray(value.cases) || !value.cases.every(isCaseSpec)) return false;
	if (value.eventLogPaths !== undefined && !stringArray(value.eventLogPaths)) return false;
	if (value.defaultLimit !== undefined && !isFiniteNumber(value.defaultLimit)) return false;
	if (value.maxTraces !== undefined && !isFiniteNumber(value.maxTraces)) return false;
	if (value.budget !== undefined && !isBudgetSpec(value.budget)) return false;
	if (value.semanticSeedsByQuery !== undefined && !isSemanticSeedsByQuery(value.semanticSeedsByQuery)) return false;
	return true;
}

function isCaseSpec(value: unknown): value is AkashaLongitudinalMemoryEvalCase {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string") return false;
	if (value.queryText !== undefined && typeof value.queryText !== "string") return false;
	if (value.limit !== undefined && !isFiniteNumber(value.limit)) return false;
	return (
		optionalStringArray(value.mustRecall) &&
		optionalStringArray(value.mustNotRecall) &&
		optionalStringArray(value.expectOpenLoops) &&
		optionalStringArray(value.expectCurrentnessChecks) &&
		optionalStringArray(value.expectActionGateIncludes) &&
		optionalStringArray(value.expectActionGateExcludes)
	);
}

function isBudgetSpec(value: unknown): value is AkashaDogfoodMemoryEvalBudget {
	if (!isRecord(value)) return false;
	return Object.values(value).every((item) => item === undefined || isFiniteNumber(item));
}

function isSemanticSeedsByQuery(value: unknown): value is Record<string, AkashaSemanticMemorySeed[]> {
	if (!isRecord(value)) return false;
	return Object.values(value).every(
		(seeds) =>
			Array.isArray(seeds) &&
			seeds.every(
				(seed) =>
					isRecord(seed) &&
					typeof seed.eventId === "string" &&
					isFiniteNumber(seed.score) &&
					isFiniteNumber(seed.similarity) &&
					(seed.reason === undefined || typeof seed.reason === "string"),
			),
	);
}

function optionalStringArray(value: unknown): boolean {
	return value === undefined || stringArray(value);
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
