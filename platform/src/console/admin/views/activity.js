'use client';
/**
 * Activity (PLAN 0.5.12, 0.8.2): every entry, newest first, as a table that fills the page, filterable by merchant,
 * admin (Owners, who see the admin list) and date (UTC days) from the toolbar: dropdowns of their names, a period menu
 * and two date fields. The names in the entries filter by them; a row opens a drawer with what the entry changed.
 * @module
 */
import { ButtonLink, Callout, Page, Pagination, Toolbar, describeProblem } from '@ss/ui';
import { ADMIN, MORE } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { ActivityTable } from '../../views/login-settings.js';
import { useListPages } from '../../views/common.js';
import { DateFields, periodFilter } from '../../views/range.js';
import { useNavigation } from '../../navigation.js';
import { usePagedList } from '../../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem } from './shell.js';

/**
 * @param {any} props loader result of `loadActivity`
 */
export function ActivityView(props) {
	const ok = props.ok === true;
	const f = ok ? props.filter : {};
	const list = usePagedList((cursor) => (ok ? adminApi.activity({ ...f, cursor }) : null), ok ? props.page : null);
	const pages = useListPages(list);
	const nav = useNavigation();
	if (!ok) return <AdminProblem problem={props.problem} />;
	const filtered = Boolean(f.merchantId || f.adminId || f.from || f.to);
	/** @param {Record<string, string | null>} next */
	const hrefFor = (next) => adminRoutes.activity({ ...f, ...next });
	return (
		<Page
			linkAs={Link}
			flush
			crumbs={[{ label: ADMIN.activityTitle }]}
			info={ADMIN.activityIntro}
			toolbar={
				<Toolbar
					label={ADMIN.activityTitle}
					filters={[
						{
							id: 'merchant',
							label: MORE.pickMerchant,
							allLabel: MORE.allMerchants,
							value: f.merchantId ?? '',
							options: props.merchants ?? [],
							onChange: (merchantId) => nav.go(hrefFor({ merchantId: merchantId || null })),
						},
						...(props.admins
							? [
									{
										id: 'admin',
										label: MORE.adminFilter,
										allLabel: MORE.allAdmins,
										value: f.adminId ?? '',
										options: props.admins,
										onChange: (/** @type {string} */ adminId) => nav.go(hrefFor({ adminId: adminId || null })),
									},
								]
							: []),
						periodFilter({
							from: f.from,
							to: f.to,
							emptyLabel: MORE.range.allTime,
							hrefFor: (range) => hrefFor(range),
							go: nav.go,
						}),
					]}
					end={
						filtered ? (
							<ButtonLink as={Link} href={adminRoutes.activity()} variant="ghost" size="sm">
								{MORE.clearFilters}
							</ButtonLink>
						) : null
					}>
					<DateFields
						from={f.from}
						to={f.to}
						fromLabel={ADMIN.filters.from}
						toLabel={ADMIN.filters.to}
						hrefFor={(range) => hrefFor(range)}
						go={nav.go}
					/>
				</Toolbar>
			}
			{...(pages.pagination ? { footer: <Pagination {...pages.pagination} /> } : {})}>
			{list.problem ? (
				<div className="p-4">
					<Callout tone="danger">{describeProblem(list.problem)}</Callout>
				</div>
			) : null}
			<ActivityTable
				items={pages.rows}
				caption={ADMIN.activityTitle}
				empty={MORE.noActivity}
				showMerchant
				details
				filterHref={(q) => adminRoutes.activity({ ...f, ...q })}
			/>
		</Page>
	);
}
