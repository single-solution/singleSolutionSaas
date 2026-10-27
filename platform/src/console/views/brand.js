'use client';
/**
 * The Branding on screens (PLAN 0.8.2 Branding): the logo (or a mark) with the name, and the accent color when an
 * Owner changed it from the default teal.
 * @module
 */
/**
 * The default accents: theme primary (Unite teal) plus earlier Integrity blue stock values a Portal may still have
 * stored; any of these leave the theme's primary (with its dark-mode shade) in place.
 */
const DEFAULT_ACCENTS = new Set(['#0f766e', '#2226f7', '#4f46e5']);

/**
 * Inline style that applies a changed accent to a subtree (the theme reads `--ss-primary`).
 * @param {string | null | undefined} accent
 * @returns {Record<string, string> | undefined}
 */
export const accentStyle = (accent) =>
	accent && /^#[0-9a-f]{6}$/i.test(accent) && !DEFAULT_ACCENTS.has(accent.toLowerCase())
		? { '--ss-primary': accent, '--ss-primary-hover': accent }
		: undefined;

/**
 * @param {{ branding: { name: string, logoUrl: string | null }, tagline?: string }} props
 */
export function BrandMark({ branding, tagline }) {
	const mark = String(branding.name ?? 'SS')
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? '')
		.join('') || 'SS';
	return (
		<div className="flex items-center gap-3">
			{branding.logoUrl ? (
				<img src={branding.logoUrl} alt="" className="size-9 rounded-control border border-line object-contain" />
			) : (
				<span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-fg font-mono text-micro font-semibold text-canvas">
					{mark}
				</span>
			)}
			<div className="min-w-0">
				<p className="truncate font-display text-title font-semibold tracking-[-0.02em] text-fg">{branding.name}</p>
				{tagline ? <p className="text-xs text-muted">{tagline}</p> : null}
			</div>
		</div>
	);
}
