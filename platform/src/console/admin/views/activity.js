'use client';
/**
 * Activity (PLAN 0.5.12, 0.8.2): every entry, newest first, filterable by merchant, admin and date (UTC days). The
 * merchant and admin filters are dropdowns of their names (admins for Owners, who see the admin list); a period picks
 * common date ranges; the names in the entries filter by them; each entry shows what it changed.
 * @module
 */
import { useState } from 'react';
import { Button, ButtonLink, Callout, Card, Form, Input, PageHeader, Select, describeProblem } from '@ss/ui';
import { ADMIN, MORE } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { ActivityTable } from '../../views/login-settings.js';
import { RangeSelect } from '../../views/range.js';
import { useNavigation } from '../../navigation.js';
import { usePagedList } from '../client.js';
import { adminApi, adminRoutes } from '../paths.js';
import { AdminProblem } from './common.js';

/**
 * @param {any} props loader result of `loadActivity`
 */
export function ActivityView(props) {
	const ok = props.ok === true;
	const f = ok ? props.filter : {};
	const [form, setForm] = useState({
		merchantId: f.merchantId ?? '',
		adminId: f.adminId ?? '',
		from: f.from ?? '',
		to: f.to ?? '',
	});
	const list = usePagedList((cursor) => (ok ? adminApi.activity({ ...f, cursor }) : null), ok ? props.page : null);
	const nav = useNavigation();
	if (!ok) return <AdminProblem problem={props.problem} />;
	const filtered = Boolean(f.merchantId || f.adminId || f.from || f.to);
	/** @param {keyof typeof form} key @param {string} value */
	const set = (key, value) => setForm((x) => ({ ...x, [key]: value }));
	const apply = () =>
		nav.go(
			adminRoutes.activity({
				merchantId: form.merchantId.trim() || null,
				adminId: form.adminId.trim() || null,
				from: form.from || null,
				to: form.to || null,
			}),
		);
	return (
		<div className="space-y-6">
			<PageHeader title={ADMIN.activityTitle} subtitle={ADMIN.activityIntro} />
			<Card>
				<Form onSubmit={apply} busy={nav.pending} aria-label={ADMIN.filters.apply}>
					<div className="grid gap-3 @md:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-[1fr_1fr_1fr_10rem_10rem_auto] @6xl:items-end">
						<Select
							label={MORE.pickMerchant}
							value={form.merchantId}
							onChange={(e) => set('merchantId', e.currentTarget.value)}
							options={[{ value: '', label: MORE.allMerchants }, ...(props.merchants ?? [])]}
						/>
						{props.admins ? (
							<Select
								label={MORE.adminFilter}
								value={form.adminId}
								onChange={(e) => set('adminId', e.currentTarget.value)}
								options={[{ value: '', label: MORE.allAdmins }, ...props.admins]}
							/>
						) : (
							<Input
								label={ADMIN.filters.admin}
								value={form.adminId}
								onChange={(e) => set('adminId', e.currentTarget.value)}
							/>
						)}
						<RangeSelect
							from={f.from}
							to={f.to}
							emptyLabel={MORE.range.allTime}
							hrefFor={(range) => adminRoutes.activity({ ...f, ...range })}
							fieldClassName="min-w-0"
						/>
						<Input
							label={ADMIN.filters.from}
							type="date"
							value={form.from}
							onChange={(e) => set('from', e.currentTarget.value)}
						/>
						<Input
							label={ADMIN.filters.to}
							type="date"
							value={form.to}
							onChange={(e) => set('to', e.currentTarget.value)}
						/>
						<div className="flex flex-wrap items-center gap-2">
							<Button type="submit" variant="secondary" loading={nav.pending}>
								{ADMIN.filters.apply}
							</Button>
							{filtered ? (
								<ButtonLink as={Link} href={adminRoutes.activity()} variant="ghost">
									{MORE.clearFilters}
								</ButtonLink>
							) : null}
						</div>
					</div>
				</Form>
			</Card>
			{list.problem ? <Callout tone="danger">{describeProblem(list.problem)}</Callout> : null}
			<ActivityTable
				items={list.items}
				empty={ADMIN.noActivity}
				showMerchant
				details
				filterHref={(q) => adminRoutes.activity({ ...f, ...q })}
				hasMore={Boolean(list.cursor)}
				loadingMore={list.loading}
				onLoadMore={() => void list.more()}
			/>
		</div>
	);
}
