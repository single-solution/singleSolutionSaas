import React from 'react';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Button } from '@saas/ui/buttons/Button';
import { Badge } from '@saas/ui/badges/Badge';

export default function Sitemap() {
	return (
		<div className="space-y-6">
			<PageHeader
				title="Dynamic XML Sitemap Manager"
				subtitle="Automatic real-time XML sitemap synchronization with Google Search Console"
				actions={
					<div className="flex gap-2">
						<Button size="sm">
							<RefreshCw size={13} />
							<span>Regenerate Sitemap</span>
						</Button>
					</div>
				}
			/>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard title="Total URLs in Sitemap" value="482" />
				<StatCard title="Last Google Ping" value="2h ago" trend="Success" />
				<StatCard title="Compression" value="Gzip Enabled" />
			</div>

			<Card title="Sitemap Indexes">
				<div className="space-y-3 font-mono text-xs">
					<div className="p-3 rounded-xl bg-zinc-50 border border-zinc-200/80 flex items-center justify-between">
						<div>
							<strong className="text-zinc-900">/sitemap.xml</strong>
							<div className="text-[10px] text-zinc-400">Master Sitemap Index</div>
						</div>
						<Badge type="active">Live & Synced</Badge>
					</div>
					<div className="p-3 rounded-xl bg-zinc-50 border border-zinc-200/80 flex items-center justify-between">
						<div>
							<strong className="text-zinc-900">/sitemaps/products.xml</strong>
							<div className="text-[10px] text-zinc-400">340 Products • Hourly update</div>
						</div>
						<Badge type="active">Live</Badge>
					</div>
				</div>
			</Card>
		</div>
	);
}
