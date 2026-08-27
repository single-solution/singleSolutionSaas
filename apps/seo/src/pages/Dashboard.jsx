import React from 'react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Card } from '@saas/ui/cards/Card';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';

export default function Dashboard() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="SEO Engine Health"
				subtitle="Automated on-page audits, sitemap freshness, and search engine indexability"
			/>

			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard title="Overall Site Health" value="94 / 100" trend="+4 pts" />
				<StatCard title="Indexed Store URLs" value="482" trend="+12 URLs" />
				<StatCard title="Missing Meta Tags" value="3" trend="-15" />
				<StatCard title="Avg Lighthouse Score" value="98" trend="Grade A" />
			</div>

			<Card title="Critical SEO Audits & Alerts">
				<DataTable
					columns={[
						{ key: 'page', label: 'Store URL / Page' },
						{ key: 'issue', label: 'Detected Issue' },
						{
							key: 'severity',
							label: 'Priority',
							render: (v) => <Badge type={v === 'High' ? 'danger' : 'warning'}>{v}</Badge>,
						},
						{ key: 'recommendation', label: 'AI Recommendation' },
					]}
					data={[
						{
							page: '/products/silk-tunic',
							issue: 'Missing Canonical Tag',
							severity: 'High',
							recommendation: 'Auto-inject <link rel="canonical">',
						},
						{
							page: '/categories/summer-sale',
							issue: 'H1 Missing',
							severity: 'Medium',
							recommendation: 'Promote category title to H1 tag',
						},
						{
							page: '/blog/summer-trends',
							issue: 'Meta Description Short',
							severity: 'Low',
							recommendation: 'Generate with AI prompt',
						},
					]}
				/>
			</Card>
		</div>
	);
}
