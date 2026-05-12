export function getAkashaUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `akasha/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
