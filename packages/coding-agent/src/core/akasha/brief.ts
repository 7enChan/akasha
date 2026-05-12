import { indexAkashaEmbeddings } from "./embedding-indexer.js";
import type { AkashaEmbeddingProvider } from "./embedding-provider.js";
import type { AkashaEmbeddingStore } from "./embedding-store.js";
import { rankRecallEvents } from "./recall-policy.js";
import { applyAkashaRedactions } from "./redaction.js";
import { retrieveTemporalContext } from "./temporal-rag.js";
import type { AkashaEvent, AkashaStore, AkashaTemporalBrief } from "./types.js";

export function buildTemporalBrief(
	store: AkashaStore,
	options: { maxEvents?: number; queryText?: string } = {},
): AkashaTemporalBrief | undefined {
	const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 12));
	const recent = applyAkashaRedactions(store.listRecent({ limit: Math.max(maxEvents * 4, 24) }));
	if (recent.length === 0) return undefined;

	const ranked = rankRecallEvents(recent, options.queryText)
		.slice(0, maxEvents)
		.sort((a, b) => a.sequence - b.sequence);

	const activeFiles = [...new Set(recent.map((event) => event.objectId).filter(isFileLike))].slice(0, 6);
	const failedTools = recent.filter(isFailedTool).slice(0, 3);
	const lastUserIntent = recent.find((event) => event.kind === "message.user.submitted");
	const lastCompaction = recent.find((event) => event.kind === "context.compacted");
	const lastBranch = recent.find((event) => event.kind === "branch.summary_created");

	const lines = ["<akasha_temporal_brief>", "Relevant recent time facts for this session:"];
	if (lastUserIntent) lines.push(`- Recent user intent: ${payloadText(lastUserIntent)}`);
	if (activeFiles.length > 0) lines.push(`- Active artifacts: ${activeFiles.join(", ")}`);
	if (failedTools.length > 0) lines.push(`- Recent failed tools: ${failedTools.map(formatShortEvent).join("; ")}`);
	if (lastCompaction) lines.push(`- Last compaction: ${payloadText(lastCompaction)}`);
	if (lastBranch) lines.push(`- Last branch return: ${payloadText(lastBranch)}`);

	lines.push("- Timeline:");
	for (const event of ranked) {
		lines.push(`  - ${formatShortEvent(event)}`);
	}
	lines.push("</akasha_temporal_brief>");

	return {
		text: lines.join("\n"),
		events: ranked,
	};
}

export async function buildTemporalBriefWithEmbeddings(
	store: AkashaStore,
	options: {
		embeddingStore: AkashaEmbeddingStore;
		embeddingProvider: AkashaEmbeddingProvider;
		maxEvents?: number;
		queryText?: string;
	} = {} as never,
): Promise<AkashaTemporalBrief | undefined> {
	const maxEvents = Math.max(1, Math.floor(options.maxEvents ?? 12));
	const events = applyAkashaRedactions(store.buildTimeline({ limit: Math.max(maxEvents * 20, 200) }));
	if (events.length === 0) return undefined;

	await indexAkashaEmbeddings(events, options.embeddingStore, options.embeddingProvider);
	const queryText = options.queryText ?? latestUserText(events) ?? "current coding session";
	const queryVector = await options.embeddingProvider.embed(queryText);
	const retrieved = await retrieveTemporalContext({
		events,
		embeddingStore: options.embeddingStore,
		queryVector,
		queryText,
		limit: maxEvents,
		semanticLimit: Math.max(maxEvents * 6, 24),
	});
	if (retrieved.events.length === 0) {
		return buildTemporalBrief(store, { maxEvents, queryText });
	}

	const recent = applyAkashaRedactions(store.listRecent({ limit: Math.max(maxEvents * 4, 24) }));
	const activeFiles = [...new Set(recent.map((event) => event.objectId).filter(isFileLike))].slice(0, 6);
	const failedTools = recent.filter(isFailedTool).slice(0, 3);
	const lines = ["<akasha_temporal_brief>", "Semantic temporal recall for this session:"];
	lines.push(`- Query: ${truncate(queryText, 180)}`);
	if (activeFiles.length > 0) lines.push(`- Active artifacts: ${activeFiles.join(", ")}`);
	if (failedTools.length > 0) lines.push(`- Recent failed tools: ${failedTools.map(formatShortEvent).join("; ")}`);
	lines.push("- Timeline:");
	for (const event of retrieved.events.slice(0, maxEvents)) {
		const match = retrieved.matches.find((item) => item.event.eventId === event.eventId);
		const reasons = match ? ` [${match.reasons.join(",")}]` : "";
		lines.push(`  - ${formatShortEvent(event)}${reasons}`);
	}
	lines.push("</akasha_temporal_brief>");

	return {
		text: lines.join("\n"),
		events: retrieved.events.slice(0, maxEvents),
	};
}

function isFailedTool(event: AkashaEvent): boolean {
	return event.kind === "tool.completed" && event.payload.isError === true;
}

function isFileLike(value: string | undefined): value is string {
	return !!value && (value.includes("/") || value.includes("."));
}

function payloadText(event: AkashaEvent): string {
	const payload = event.payload;
	const text =
		typeof payload.text === "string"
			? payload.text
			: typeof payload.summary === "string"
				? payload.summary
				: typeof payload.command === "string"
					? payload.command
					: typeof payload.path === "string"
						? payload.path
						: JSON.stringify(payload);
	return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function formatShortEvent(event: AkashaEvent): string {
	const object = event.objectId ? ` ${event.objectId}` : "";
	const tool = event.toolCallId ? ` [${event.toolCallId}]` : "";
	return `#${event.sequence} ${event.kind}${object}${tool}: ${payloadText(event)}`;
}

function latestUserText(events: AkashaEvent[]): string | undefined {
	return [...events].reverse().find((event) => event.kind === "message.user.submitted")?.payload.text as
		| string
		| undefined;
}

function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
