'use client';
/**
 * The Branding on screens (PLAN 0.8.2 Branding): the logo (or a mark) with the name, and the accent color when an
 * Owner changed it from the default blue.
 * @module
 */
import { Icon } from '@ss/ui';

/**
 * The default accents: the theme's own primary color (Integrity blue, redesign 2) and the one before it, which a Portal
 * set up earlier may still have stored; either leaves the theme's primary (with its dark-mode shade) in place.
 */
const DEFAULT_ACCENTS = new Set(['#2226f7', '#4f46e5']);

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
	return (
		<div className="flex items-center gap-3">
			{branding.logoUrl ? (
				<img src={branding.logoUrl} alt="" className="size-10 rounded-xl object-contain" />
			) : (
				<span className="flex size-10 items-center justify-center rounded-xl bg-primary text-on-primary">
					<Icon name="zap" size={18} />
				</span>
			)}
			<div className="min-w-0">
				<p className="truncate text-sm font-extrabold tracking-tight text-fg">{branding.name}</p>
				{tagline ? <p className="text-xs text-muted">{tagline}</p> : null}
			</div>
		</div>
	);
}
