// Small pure formatting helpers, safe to import on both server and client.

export function formatBytes(n: number | null | undefined): string {
	if (!n || n < 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatNumber(n: number | null | undefined): string {
	return (n ?? 0).toLocaleString('en-US');
}

const RELATIVE_STEPS: [number, Intl.RelativeTimeFormatUnit][] = [
	[60, 'second'],
	[60, 'minute'],
	[24, 'hour'],
	[7, 'day'],
	[4.34524, 'week'],
	[12, 'month'],
	[Number.POSITIVE_INFINITY, 'year']
];

export function formatRelative(ts: number | Date | null | undefined): string {
	if (ts == null) return '—';
	const ms = ts instanceof Date ? ts.getTime() : ts;
	const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
	let diff = (ms - Date.now()) / 1000; // seconds; negative = past
	let unit: Intl.RelativeTimeFormatUnit = 'second';
	for (const [step, u] of RELATIVE_STEPS) {
		if (Math.abs(diff) < step) {
			unit = u;
			break;
		}
		diff /= step;
	}
	return rtf.format(Math.round(diff), unit);
}

export function formatDateTime(ts: number | Date | null | undefined): string {
	if (ts == null) return '—';
	const d = ts instanceof Date ? ts : new Date(ts);
	return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDuration(fromMs?: number | null, toMs?: number | null): string {
	if (!fromMs) return '—';
	const end = toMs ?? Date.now();
	let s = Math.max(0, Math.round((end - fromMs) / 1000));
	const h = Math.floor(s / 3600);
	s -= h * 3600;
	const m = Math.floor(s / 60);
	s -= m * 60;
	if (h) return `${h}h ${m}m`;
	if (m) return `${m}m ${s}s`;
	return `${s}s`;
}
