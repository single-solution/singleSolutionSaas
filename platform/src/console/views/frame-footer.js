'use client';
/**
 * The help link at the bottom of the console sidebars (the first support channel the Owner set, merchants only), above
 * the account and the theme that the frame draws there itself. It folds to an icon when the sidebar is the icon rail.
 * @module
 */
import { Icon, cx } from '@ss/ui';

/**
 * @param {{ rail: boolean, help?: { label: string, url: string } | null }} props
 */
export function FrameFooter({ rail, help }) {
	if (!help) return null;
	return (
		<a
			href={help.url}
			title={help.label}
			{...(/^https?:/i.test(help.url) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
			className={cx(
				'ss-motion ss-press flex h-9 items-center gap-2.5 rounded-lg text-sm font-medium text-fg/80 hover:bg-surface-2 hover:text-fg',
				'focus-visible:outline-2 focus-visible:outline-focus',
				rail ? 'justify-center' : 'px-2.5',
			)}>
			<span aria-hidden="true" className="text-info">
				<Icon name="help" size={17} />
			</span>
			<span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{help.label}</span>
		</a>
	);
}
