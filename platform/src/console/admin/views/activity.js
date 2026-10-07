'use client';
/**
 * Activity (PLAN 0.5.12, 0.8.2): every entry, newest first, filterable by merchant, admin and date (UTC days).
 * @module
 */
import { useState } from 'react';
import { Button, Callout, Card, Form, Input, PageHeader, describeProblem } from '@ss/ui';
import { ADMIN } from '../../../texts/console.js';
import { ActivityTable } from '../../views/login-settings.js';
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
	if (!ok) return <AdminProblem problem={props.problem} />;
	/** @param {keyof typeof form} key @param {string} value */
	const set = (key, value) => setForm((x) => ({ ...x, [key]: value }));
	const apply = () =>
		window.location.assign(
			adminRoutes.activity({
				merchantId: form.merchantId.trim() || null,
				adminId: form.adminId.trim() || null,
				from: form.from || null,
				to: form.to || null,
			}),
		);
	return (
		<div className="space-y-6">
			<PageHeader title={ADMIN.activityTitle} />
			<Card>
				<Form onSubmit={apply} aria-label={ADMIN.filters.apply}>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_10rem_10rem_auto] lg:items-end">
						<Input
							label={ADMIN.filters.merchant}
							value={form.merchantId}
							onChange={(e) => set('merchantId', e.currentTarget.value)}
						/>
						<Input
							label={ADMIN.filters.admin}
							value={form.adminId}
							onChange={(e) => set('adminId', e.currentTarget.value)}
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
						<Button type="submit" variant="secondary">
							{ADMIN.filters.apply}
						</Button>
					</div>
				</Form>
			</Card>
			{list.problem ? <Callout tone="danger">{describeProblem(list.problem)}</Callout> : null}
			<ActivityTable
				items={list.items}
				empty={ADMIN.noActivity}
				showMerchant
				hasMore={Boolean(list.cursor)}
				onLoadMore={() => void list.more()}
			/>
		</div>
	);
}
