import React from 'react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { StatCard } from '@saas/ui/cards/StatCard';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';

export default function AuditResults() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="Live Crawl Audits"
				subtitle="Automated synthetic crawler results across all public storefront routes"
			/>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard title="Passed Checks" value="142" trend="98.2%" />
				<StatCard title="Warnings" value="4" trend="Non-blocking" />
				<StatCard title="Critical Errors" value="0" trend="100% Healthy" />
			</div>

			<Card title="Latest Automated Crawl Log">
				<DataTable
					columns={[
						{ key: 'rule', label: 'Audit Check Rule' },
						{ key: 'affected', label: 'Affected URLs' },
						{
							key: 'status',
							label: 'Verdict',
							render: (v) => <Badge type={v === 'Pass' ? 'active' : 'warning'}>{v}</Badge>,
						},
						{ key: 'fix', label: 'Automated Fix Action' },
					]}
					data={[
						{ rule: 'Robots.txt Crawlability', affected: '0 URLs', status: 'Pass', fix: 'Configured & Valid' },
						{ rule: 'OpenGraph Image Resizing', affected: '2 URLs', status: 'Warning', fix: 'Auto-resizing applied' },
						{ rule: 'Structured Data Hierarchy', affected: '0 URLs', status: 'Pass', fix: 'Schema.org JSON-LD generated' },
					]}
				/>
			</Card>
		</div>
	);
}
