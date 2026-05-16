import { Marked, type Token, type Tokens } from "marked";

const markdownParser = new Marked();

export interface TelegramFormattedText {
	text: string;
	parseMode: "HTML";
	plainText: string;
}

export function formatTelegramMessageText(markdown: string): TelegramFormattedText {
	const tokens = markdownParser.lexer(markdown);
	const htmlText = renderTelegramHtmlBlocks(tokens).trim();
	const plainText = renderTelegramPlainBlocks(tokens).trim();
	return {
		text: htmlText || escapeTelegramHtml(markdown),
		parseMode: "HTML",
		plainText: plainText || markdown,
	};
}

function renderTelegramHtmlBlocks(tokens: readonly Token[]): string {
	return tokens.map(renderTelegramHtmlBlock).join("");
}

function renderTelegramHtmlBlock(token: Token): string {
	switch (token.type) {
		case "space":
			return "\n";
		case "hr":
			return "-----\n\n";
		case "heading": {
			const heading = token as Tokens.Heading;
			return `<b>${renderTelegramHtmlInline(heading.tokens)}</b>\n\n`;
		}
		case "paragraph": {
			const paragraph = token as Tokens.Paragraph;
			return `${renderTelegramHtmlInline(paragraph.tokens)}\n\n`;
		}
		case "text": {
			const text = token as Tokens.Text;
			return `${renderTelegramHtmlInlineOrText(text)}\n`;
		}
		case "code": {
			const code = token as Tokens.Code;
			return `<pre>${escapeTelegramHtml(code.text)}</pre>\n\n`;
		}
		case "blockquote": {
			const blockquote = token as Tokens.Blockquote;
			const body = renderTelegramHtmlBlocks(blockquote.tokens).trim();
			return body ? `<blockquote>${body}</blockquote>\n\n` : "";
		}
		case "list": {
			const list = token as Tokens.List;
			return `${renderTelegramHtmlList(list)}\n\n`;
		}
		case "table": {
			const table = token as Tokens.Table;
			return `${renderTelegramHtmlTable(table)}\n\n`;
		}
		case "html": {
			const html = token as Tokens.HTML;
			return `${escapeTelegramHtml(html.text)}\n\n`;
		}
		case "def":
			return "";
		default:
			return renderUnknownTokenText(token);
	}
}

function renderTelegramHtmlInline(tokens: readonly Token[] | undefined): string {
	return (tokens ?? []).map(renderTelegramHtmlInlineToken).join("");
}

function renderTelegramHtmlInlineOrText(token: Tokens.Text): string {
	return token.tokens?.length ? renderTelegramHtmlInline(token.tokens) : escapeTelegramHtml(token.text);
}

function renderTelegramHtmlInlineToken(token: Token): string {
	switch (token.type) {
		case "escape": {
			const escapedToken = token as Tokens.Escape;
			return escapeTelegramHtml(escapedToken.text);
		}
		case "text": {
			const text = token as Tokens.Text;
			return renderTelegramHtmlInlineOrText(text);
		}
		case "strong": {
			const strong = token as Tokens.Strong;
			return `<b>${renderTelegramHtmlInline(strong.tokens)}</b>`;
		}
		case "em": {
			const em = token as Tokens.Em;
			return `<i>${renderTelegramHtmlInline(em.tokens)}</i>`;
		}
		case "codespan": {
			const code = token as Tokens.Codespan;
			return `<code>${escapeTelegramHtml(code.text)}</code>`;
		}
		case "del": {
			const del = token as Tokens.Del;
			return `<s>${renderTelegramHtmlInline(del.tokens)}</s>`;
		}
		case "br":
			return "\n";
		case "link": {
			const link = token as Tokens.Link;
			return renderTelegramHtmlLink(link);
		}
		case "image": {
			const image = token as Tokens.Image;
			return renderTelegramHtmlImage(image);
		}
		case "html": {
			const html = token as Tokens.HTML;
			return escapeTelegramHtml(html.text);
		}
		default:
			return renderUnknownTokenText(token);
	}
}

function renderTelegramHtmlList(list: Tokens.List): string {
	const start = typeof list.start === "number" ? list.start : 1;
	return list.items
		.map((item, index) => {
			const marker = list.ordered ? `${start + index}. ` : "- ";
			const task = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
			return renderTelegramHtmlListItem(item, `${marker}${task}`);
		})
		.join("\n");
}

function renderTelegramHtmlListItem(item: Tokens.ListItem, prefix: string): string {
	const body = renderTelegramHtmlBlocks(item.tokens).trim() || escapeTelegramHtml(item.text.trim());
	const lines = body.split("\n");
	const [first = "", ...rest] = lines;
	return `${prefix}${first}${rest.map((line) => `\n  ${line}`).join("")}`;
}

function renderTelegramHtmlTable(table: Tokens.Table): string {
	const headers = table.header.map((cell, index) => renderTelegramPlainTableCell(cell) || `Column ${index + 1}`);
	return table.rows
		.map((row, rowIndex) => {
			const title = row[0] ? renderTelegramPlainTableCell(row[0]) : `Row ${rowIndex + 1}`;
			const values = row
				.map((cell, cellIndex) => {
					const label = headers[cellIndex] ?? `Column ${cellIndex + 1}`;
					const value = renderTelegramHtmlInline(cell.tokens) || escapeTelegramHtml(cell.text);
					return `- <b>${escapeTelegramHtml(label)}:</b> ${value}`;
				})
				.join("\n");
			return `<b>${escapeTelegramHtml(title || `Row ${rowIndex + 1}`)}</b>\n${values}`;
		})
		.join("\n\n");
}

function renderTelegramHtmlLink(link: Tokens.Link): string {
	const label = renderTelegramHtmlInline(link.tokens) || escapeTelegramHtml(link.text);
	const href = normalizeTelegramHref(link.href);
	if (!href) {
		return `${label} (${escapeTelegramHtml(link.href)})`;
	}
	return `<a href="${escapeTelegramHtmlAttribute(href)}">${label}</a>`;
}

function renderTelegramHtmlImage(image: Tokens.Image): string {
	const label = image.text.trim() || image.href;
	const href = normalizeTelegramHref(image.href);
	if (!href) {
		return escapeTelegramHtml(label);
	}
	return `<a href="${escapeTelegramHtmlAttribute(href)}">${escapeTelegramHtml(label)}</a>`;
}

function renderTelegramPlainBlocks(tokens: readonly Token[]): string {
	return tokens.map(renderTelegramPlainBlock).join("");
}

function renderTelegramPlainBlock(token: Token): string {
	switch (token.type) {
		case "space":
			return "\n";
		case "hr":
			return "-----\n\n";
		case "heading": {
			const heading = token as Tokens.Heading;
			return `${renderTelegramPlainInline(heading.tokens)}\n\n`;
		}
		case "paragraph": {
			const paragraph = token as Tokens.Paragraph;
			return `${renderTelegramPlainInline(paragraph.tokens)}\n\n`;
		}
		case "text": {
			const text = token as Tokens.Text;
			return `${renderTelegramPlainInlineOrText(text)}\n`;
		}
		case "code": {
			const code = token as Tokens.Code;
			return `${code.text}\n\n`;
		}
		case "blockquote": {
			const blockquote = token as Tokens.Blockquote;
			return renderTelegramPlainBlocks(blockquote.tokens)
				.trim()
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")
				.concat("\n\n");
		}
		case "list": {
			const list = token as Tokens.List;
			return `${renderTelegramPlainList(list)}\n\n`;
		}
		case "table": {
			const table = token as Tokens.Table;
			return `${renderTelegramPlainTable(table)}\n\n`;
		}
		case "html": {
			const html = token as Tokens.HTML;
			return `${html.text}\n\n`;
		}
		case "def":
			return "";
		default:
			return renderUnknownTokenText(token);
	}
}

function renderTelegramPlainInline(tokens: readonly Token[] | undefined): string {
	return (tokens ?? []).map(renderTelegramPlainInlineToken).join("");
}

function renderTelegramPlainInlineOrText(token: Tokens.Text): string {
	return token.tokens?.length ? renderTelegramPlainInline(token.tokens) : token.text;
}

function renderTelegramPlainInlineToken(token: Token): string {
	switch (token.type) {
		case "escape": {
			const escapedToken = token as Tokens.Escape;
			return escapedToken.text;
		}
		case "text": {
			const text = token as Tokens.Text;
			return renderTelegramPlainInlineOrText(text);
		}
		case "strong": {
			const strong = token as Tokens.Strong;
			return renderTelegramPlainInline(strong.tokens);
		}
		case "em": {
			const em = token as Tokens.Em;
			return renderTelegramPlainInline(em.tokens);
		}
		case "codespan": {
			const code = token as Tokens.Codespan;
			return code.text;
		}
		case "del": {
			const del = token as Tokens.Del;
			return renderTelegramPlainInline(del.tokens);
		}
		case "br":
			return "\n";
		case "link": {
			const link = token as Tokens.Link;
			const label = renderTelegramPlainInline(link.tokens) || link.text;
			return link.href && link.href !== label ? `${label} (${link.href})` : label;
		}
		case "image": {
			const image = token as Tokens.Image;
			const label = image.text.trim() || "image";
			return image.href ? `${label} (${image.href})` : label;
		}
		case "html": {
			const html = token as Tokens.HTML;
			return html.text;
		}
		default:
			return renderUnknownTokenText(token);
	}
}

function renderTelegramPlainList(list: Tokens.List): string {
	const start = typeof list.start === "number" ? list.start : 1;
	return list.items
		.map((item, index) => {
			const marker = list.ordered ? `${start + index}. ` : "- ";
			const task = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
			return renderTelegramPlainListItem(item, `${marker}${task}`);
		})
		.join("\n");
}

function renderTelegramPlainListItem(item: Tokens.ListItem, prefix: string): string {
	const body = renderTelegramPlainBlocks(item.tokens).trim() || item.text.trim();
	const lines = body.split("\n");
	const [first = "", ...rest] = lines;
	return `${prefix}${first}${rest.map((line) => `\n  ${line}`).join("")}`;
}

function renderTelegramPlainTable(table: Tokens.Table): string {
	const headers = table.header.map((cell, index) => renderTelegramPlainTableCell(cell) || `Column ${index + 1}`);
	return table.rows
		.map((row, rowIndex) => {
			const title = row[0] ? renderTelegramPlainTableCell(row[0]) : `Row ${rowIndex + 1}`;
			const values = row
				.map((cell, cellIndex) => {
					const label = headers[cellIndex] ?? `Column ${cellIndex + 1}`;
					const value = renderTelegramPlainTableCell(cell);
					return `- ${label}: ${value}`;
				})
				.join("\n");
			return `${title || `Row ${rowIndex + 1}`}\n${values}`;
		})
		.join("\n\n");
}

function renderTelegramPlainTableCell(cell: Tokens.TableCell): string {
	return renderTelegramPlainInline(cell.tokens).trim() || cell.text.trim();
}

function normalizeTelegramHref(href: string): string | undefined {
	const trimmed = href.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed);
		return ["http:", "https:", "mailto:", "tg:"].includes(parsed.protocol) ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

function escapeTelegramHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeTelegramHtmlAttribute(text: string): string {
	return escapeTelegramHtml(text).replace(/"/g, "&quot;");
}

function renderUnknownTokenText(token: Token): string {
	const record = token as { text?: unknown; raw?: unknown };
	if (typeof record.text === "string") return escapeTelegramHtml(record.text);
	if (typeof record.raw === "string") return escapeTelegramHtml(record.raw);
	return "";
}
