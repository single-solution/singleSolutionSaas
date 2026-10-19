'use client';
/**
 * The bottom of the merchant sidebar, above the account and the theme that the frame draws there itself: the credit
 * balance (a link to Usage and credits) and the help link (the first support channel the Owner set). Both fold to an
 * icon when the sidebar is the icon rail.
 * @module
 */
import { Icon, cx, formatCredits } from '@ss/ui';
import { MERCHANT } from '../../texts/console.js';
import { Link } from '../link.js';
import { routes } from '../paths.js';

/** The look of a footer row (the same for the balance and the help link). @param {boolean} rail */
const rowClass = (rail) =>
	cx(
		'ss-motion ss-press flex h-9 items-center gap-2.5 rounded-lg text-sm font-medium text-fg/80 hover:bg-surface-2 hover:text-fg',
		'focus-visible:outline-2 focus-visible:outline-focus',
		rail ? 'justify-center' : 'px-2.5',
	);

/**
 * @param {{ rail: boolean, balance?: number | null, help?: { label: string, url: string } | null }} props
 *   `balance`: the credits left (a link to Usage and credits); nothing without it
 */
export function FrameFooter({ rail, balance = null, help = null }) {
	if (balance === null && !help) return null;
	return (
		<div className="space-y-0.5">
			{balance !== null ? (
				<Link href={routes.credits()} title={MERCHANT.balanceLink} className={rowClass(rail)}>
					<span aria-hidden="true" className="text-muted">
						<Icon name="wallet" size={17} />
					</span>
					<span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>
						{MERCHANT.balanceLink}
						<span className="ml-1.5 tabular-nums text-muted">{formatCredits(balance)}</span>
					</span>
				</Link>
			) : null}
			{help ? (
				<a
					href={help.url}
					title={help.label}
					{...(/^https?:/i.test(help.url) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
					className={rowClass(rail)}>
					<span aria-hidden="true" className="text-info">
						<Icon name="help" size={17} />
					</span>
					<span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{help.label}</span>
				</a>
			) : null}
		</div>
	);
}
