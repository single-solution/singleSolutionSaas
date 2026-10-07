'use client';
/**
 * Admin Overview (PLAN 0.8.2): totals, recent activity and the warning while e-mail sending is not set up (e-mails are
 * skipped then, PLAN 0.5.10). Credits, needs attention and per-product numbers join with billing (step 3) and products
 * on websites (step 5).
 * @module
 */
import { ButtonLink, Callout, Card, PageHeader, Stat } from '@ss/ui';
import { ADMIN } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { ActivityTable } from '../../views/login-settings.js';
import { adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';

/**
 * @param {any} props loader result of `loadOverview` plus `admin`
 */
export function OverviewView(props) {
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const o = props.overview ?? {};
	return (
		<div className="space-y-6">
			<PageHeader title={ADMIN.overviewTitle} />
			{o.mailConfigured === false ? (
				<Callout
					tone="warning"
					actions={
						adminCan(props.admin, 'portal_settings.write') ? (
							<ButtonLink as={Link} href={adminRoutes.settings()} variant="secondary" size="sm">
								{ADMIN.smtpFix}
							</ButtonLink>
						) : null
					}>
					{ADMIN.smtpWarning}
				</Callout>
			) : null}
			<div className="grid gap-4 sm:grid-cols-2">
				<Stat label={ADMIN.totals.merchants} value={o.merchants ?? 0} icon="users" />
				<Stat label={ADMIN.totals.websites} value={o.websites ?? 0} icon="globe" />
			</div>
			<Card title={ADMIN.recentActivity}>
				<ActivityTable items={o.recentActivity ?? []} empty={ADMIN.noActivity} showMerchant />
			</Card>
		</div>
	);
}
