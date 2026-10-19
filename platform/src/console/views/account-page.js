'use client';
/**
 * The page of the signed-in person's own account, shared by the merchant Account and the admin My account: a `Page`
 * whose parts (Details, Sign-in, Two-step, Activity) are inner-navigation items with addresses of their own. The
 * activity part is a table that fills the page, with the pagination in the footer; the others are settings cards.
 * @module
 */
import { Page } from '@ss/ui';
import { LOGIN } from '../../texts/console.js';
import { Link } from '../link.js';
import { useOwnActivity } from './login-settings.js';

/** The id of the part that shows the person's own activity. */
export const ACTIVITY_PART = 'activity';

/**
 * @param {{ title: string, info: string, part: string,
 *   parts: Array<{ id: string, label: string, icon: import('@ss/ui').IconName, href: string, body?: import('react').ReactNode,
 *     dot?: 'success' | 'warning' | 'danger' | 'neutral', dotLabel?: string }>,
 *   activity: { path: string, href: string, initial?: { items: any[], nextCursor?: string | null } },
 *   facts?: import('@ss/ui').PageFact[], status?: import('@ss/ui').PageStatus[], before?: import('react').ReactNode }} props
 *   `parts` lists the settings parts; the activity part (`ACTIVITY_PART`) is added at its end; `before` is drawn above
 *   the page (the frame's billing banner)
 */
export function AccountPage({ title, info, part, parts, activity, facts, status, before }) {
	const own = useOwnActivity(activity.path, activity.initial);
	const shown = part === ACTIVITY_PART ? ACTIVITY_PART : (parts.find((p) => p.id === part)?.id ?? parts[0]?.id ?? ACTIVITY_PART);
	const current = parts.find((p) => p.id === shown);
	return (
		<>
			{before ?? null}
			<Page
				linkAs={Link}
				flush={shown === ACTIVITY_PART}
				bodyKey={shown}
				crumbs={[{ label: title }]}
				info={info}
				{...(status ? { status } : {})}
				{...(facts ? { facts } : {})}
				nav={{
					value: shown,
					label: title,
					items: [
						...parts.map(({ id, label, icon, href, dot, dotLabel }) => ({
							id,
							label,
							icon,
							href,
							...(dot ? { dot, dotLabel: dotLabel ?? '' } : {}),
						})),
						{ id: ACTIVITY_PART, label: LOGIN.activityTitle, icon: 'activity', href: activity.href },
					],
				}}
				{...(shown === ACTIVITY_PART && own.footer ? { footer: own.footer } : {})}>
				{shown === ACTIVITY_PART ? own.body : (current?.body ?? null)}
			</Page>
		</>
	);
}
