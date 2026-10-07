/** The tier badge shared by the renderers that show a tier, with its token-only styles. */
import { el, paint } from './dom.js';

export const BADGE_STYLES = `
.ss-grades-badge { --ss-grades-c: var(--ss-grades-tier, var(--ss-color-primary)); display: inline-flex; align-items: center;
  gap: var(--ss-space-1); border-radius: var(--ss-radius-sm); padding: 0 var(--ss-space-2); font: var(--ss-font-body);
  font-weight: var(--ss-font-weight-bold, 700); line-height: 1.6; white-space: nowrap; }
.ss-grades-badge--soft { color: var(--ss-color-text); background: color-mix(in srgb, var(--ss-grades-c) 14%, var(--ss-color-surface));
  border: 1px solid color-mix(in srgb, var(--ss-grades-c) 45%, var(--ss-color-surface)); }
.ss-grades-badge--solid { color: var(--ss-color-on-primary); background: var(--ss-grades-c); border: 1px solid var(--ss-grades-c); }
.ss-grades-badge--outline { color: var(--ss-color-text); background: none; border: 1px solid var(--ss-grades-c); }
.ss-grades-badge__dot { width: 0.5em; height: 0.5em; border-radius: 50%; background: var(--ss-grades-c); }
.ss-grades-error { color: var(--ss-color-danger); }
.ss-grades-muted { color: var(--ss-color-text-muted); }
`;

/**
 * @param {import('./dom.js').DomLike} dom
 * @param {import('../headless/store.js').Badge} badge
 * @param {{ short?: boolean }} [options]
 */
export const badgeNode = (dom, badge, { short = false } = {}) =>
	paint(
		el(
			dom,
			'span',
			{
				class: `ss-grades-badge ss-grades-badge--${badge.style}`,
				role: 'img',
				'aria-label': badge.ariaLabel,
				'data-tier': badge.key,
			},
			[el(dom, 'span', { class: 'ss-grades-badge__dot', 'aria-hidden': 'true' }), short ? badge.shortLabel : badge.label],
		),
		badge.color,
	);
