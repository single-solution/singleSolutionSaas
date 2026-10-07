'use client';
/**
 * The Branding on screens (PLAN 0.8.2 Branding): the logo (or a mark) with the name, and the accent colour when an
 * Owner changed it from the default indigo.
 * @module
 */
import { Icon } from '@ss/ui';

/** The default accent (the theme's own primary colour). */
export const DEFAULT_ACCENT = '#4f46e5';

/**
 * Inline style that applies a changed accent to a subtree (the theme reads `--ss-primary`).
 * @param {string | null | undefined} accent
 * @returns {Record<string, string> | undefined}
 */
export const accentStyle = (accent) =>
	accent && /^#[0-9a-f]{6}$/i.test(accent) && accent.toLowerCase() !== DEFAULT_ACCENT
		? { '--ss-primary': accent, '--ss-primary-hover': accent }
		: undefined;

/**
 * @param {{ branding: { name: string, logoUrl: string | null }, tagline?: string }} props
 */
export function BrandMark({ branding, tagline }) {
	return (
		<div className="flex items-center gap-3">
			{branding.logoUrl ? (
				<img src={branding.logoUrl} alt="" className="size-10 rounded-xl object-contain" />
			) : (
				<span className="flex size-10 items-center justify-center rounded-xl bg-primary text-on-primary shadow-card">
					<Icon name="zap" size={18} />
				</span>
			)}
			<div className="min-w-0">
				<p className="truncate text-sm font-extrabold tracking-tight text-fg">{branding.name}</p>
				{tagline ? <p className="text-[11px] font-bold uppercase tracking-wider text-muted">{tagline}</p> : null}
			</div>
		</div>
	);
}
