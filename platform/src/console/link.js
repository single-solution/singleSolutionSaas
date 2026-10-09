'use client';
/**
 * Router links of the consoles (Next's client-side navigation; a plain `<a>` with an `href`). Every link reports a
 * click whose page is still on the way to the progress bar on top of the page and marks itself pending (a pressed
 * look); `hint` adds the small spinner beside it (menu items and list rows). Routes with a loading skeleton are
 * prefetched up to it, so most clicks switch to the skeleton at once and the hint never shows (PLAN 0.6 motion).
 * @module
 */
import NextLink, { useLinkStatus } from 'next/link.js';
import { PendingHint, useNavigationProgress } from '@ss/ui';

/** Next's link (its typings do not resolve through the `.js` specifier). */
const RouterLink = /** @type {import('react').ElementType} */ (/** @type {any} */ (NextLink));

/** @typedef {{ href: string, children?: import('react').ReactNode, [prop: string]: unknown }} LinkProps */

/**
 * The pending state of the enclosing link.
 * @param {{ hint: boolean }} props
 */
function LinkStatus({ hint }) {
	const { pending } = useLinkStatus();
	useNavigationProgress(pending);
	if (hint) return <PendingHint pending={pending} />;
	return pending ? <span hidden data-link-pending="" /> : null;
}

/**
 * @param {LinkProps & { hint?: boolean }} props
 */
function ConsoleLink({ children, hint = false, ...props }) {
	return (
		<RouterLink {...props}>
			{children}
			<LinkStatus hint={hint} />
		</RouterLink>
	);
}

/** @type {import('react').ElementType} */
export const Link = ConsoleLink;

/**
 * A link with the pending spinner: the consoles' menu (`AppShell` `linkAs`).
 * @param {LinkProps} props
 */
function HintLink(props) {
	return <ConsoleLink {...props} hint />;
}

/** @type {import('react').ElementType} */
export const NavLink = HintLink;
