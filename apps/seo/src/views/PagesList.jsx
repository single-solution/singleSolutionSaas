import React, { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Input } from '@saas/ui/inputs/TextInput';

export default function PagesList() {
	const [search, setSearch] = useState('');

	const pages = [
		{ id: 'p_1', url: '/', title: "Home | Sister's Boutique", status: 'indexed', score: 98 },
		{ id: 'p_2', url: '/products/velvet-embroidered', title: 'Velvet Suit | Winter', status: 'indexed', score: 92 },
		{ id: 'p_3', url: '/categories/festive', title: 'Festive Collection', status: 'needs_audit', score: 76 },
	];

	return (
		<div className="space-y-6">
			<PageHeader title="Storefront URL Index" subtitle="Catalog of crawlable storefront URLs and their audit statuses" />

			<div className="space-y-4">
				<Input placeholder="Search by URL path or page title..." value={search} onChange={(e) => setSearch(e.target.value)} />
				<DataTable
					columns={[
						{
							key: 'url',
							label: 'URL Path',
							render: (v, r) => (
								<Link href={`/pages/${r.id}`} className="font-mono text-zinc-900 font-semibold hover:underline">
									{v}
								</Link>
							),
						},
						{ key: 'title', label: 'Meta Title' },
						{
							key: 'status',
							label: 'Indexing Status',
							render: (v) => <Badge type={v === 'indexed' ? 'active' : 'warning'}>{v.toUpperCase()}</Badge>,
						},
						{
							key: 'score',
							label: 'SEO Score',
							render: (v) => (
								<strong className={`font-mono ${v >= 90 ? 'text-emerald-600' : 'text-amber-600'}`}>{v}/100</strong>
							),
						},
					]}
					data={pages}
				/>
			</div>
		</div>
	);
}
