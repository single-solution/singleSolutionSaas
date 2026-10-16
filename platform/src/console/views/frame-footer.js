'use client';
/**
 * The bottom of the console sidebars: a help link (the first support channel the Owner set, merchants only) and the
 * account menu (My account, Sign out). Both fold to icons when the sidebar is the icon rail.
 * @module
 */
import { AccountMenu, Icon, cx } from '@ss/ui';

/**
 * @param {{ rail: boolean, help?: { label: string, url: string } | null, account: { name: string, email?: string,
 *   label: string, items: import('@ss/ui').MenuItem[] } }} props
 */
export function FrameFooter({ rail, help, account }) {
	return (
		<div className="space-y-1">
			{help ? (
				<a
					href={help.url}
					title={help.label}
					{...(/^https?:/i.test(help.url) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
					className={cx(
						'ss-motion ss-press flex h-9 items-center gap-2.5 rounded-lg text-sm font-medium text-fg/80 hover:bg-surface-2 hover:text-fg',
						'focus-visible:outline-2 focus-visible:outline-focus',
						rail ? 'justify-center' : 'px-2.5',
					)}>
					<span aria-hidden="true" className="text-muted">
						<Icon name="help" size={17} />
					</span>
					<span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{help.label}</span>
				</a>
			) : null}
			<AccountMenu
				name={account.name}
				{...(account.email ? { email: account.email } : {})}
				items={account.items}
				label={account.label}
				compact={rail}
				placement="up"
			/>
		</div>
	);
}
