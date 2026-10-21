'use client';
/**
 * The page of the signed-in person's own account, shared by the merchant Account and the admin My account:
 * a `Page` whose parts (Details / Profile, Sign-in, Two-step, Activity) are all open on ONE page as `sections`
 * (flat layout 2026-10-21, K-4b). The inner navigation lists them as jumps. The activity part is a timeline of
 * rich rows with a "Show more" button.
 * @module
 */
import { useEffect } from 'react';
import { Page, SettingsCard } from '@ss/ui';
import { LOGIN, MORE } from '../../texts/console.js';
import { Link } from '../link.js';
import { OwnActivityTimeline } from './login-settings.js';

/** The id of the part that shows the person's own activity. */
export const ACTIVITY_PART = 'activity';

/**
 * @param {{ title: string, info: string, part?: string,
 *   parts: Array<{ id: string, label: string, icon: import('@ss/ui').IconName, href?: string, body?: import('react').ReactNode,
 *     dot?: 'success' | 'warning' | 'danger' | 'neutral', dotLabel?: string }>,
 *   activity: { path: string, href?: string, initial?: { items: any[], nextCursor?: string | null } },
 *   facts?: import('@ss/ui').PageFact[], status?: import('@ss/ui').PageStatus[], before?: import('react').ReactNode }} props
 *   `parts` lists the settings parts; the activity part (`ACTIVITY_PART`) is added at its end; `before` is drawn above
 *   the page (the frame's billing banner)
 */
export function AccountPage({ title, info, part, parts, activity, facts, status, before }) {
	useEffect(() => {
		if (part && part !== 'details' && part !== 'profile' && typeof window !== 'undefined' && !window.location.hash) {
			const el = document.getElementById(part);
			if (el) {
				el.scrollIntoView?.({ behavior: 'smooth' });
				window.history.replaceState?.(null, '', `#${part}`);
			}
		}
	}, [part]);

	const sections = [
		...parts.map(({ id, label, icon, body, dot, dotLabel }) => ({
			id,
			label,
			...(icon ? { icon } : {}),
			...(dot ? { dot, dotLabel: dotLabel ?? '' } : {}),
			body: body ?? null,
		})),
		...(activity
			? [
					{
						id: ACTIVITY_PART,
						label: LOGIN.activityTitle,
						icon: /** @type {const} */ ('activity'),
						body: (
							<SettingsCard
								title={LOGIN.activityTitle}
								description={MORE.activityIntro ?? 'Recent sign-ins and security actions on your account.'}>
								<OwnActivityTimeline path={activity.path} initial={activity.initial} />
							</SettingsCard>
						),
					},
				]
			: []),
	];

	return (
		<>
			{before ?? null}
			<Page
				linkAs={Link}
				crumbs={[{ label: title }]}
				info={info}
				sections={sections}
				{...(status ? { status } : {})}
				{...(facts ? { facts } : {})}
			/>
		</>
	);
}
