import React, { useState } from 'react';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Badge } from '@saas/ui/badges/Badge';
import { StatCard } from '@saas/ui/cards/StatCard';

export default function SeoSandbox() {
	const [url, setUrl] = useState('https://sistersboutique.com/products/velvet');
	const [audited, setAudited] = useState(false);

	return (
		<div className="space-y-6 max-w-3xl">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-zinc-950">Live URL SEO Auditor Simulator</h1>
					<p className="text-xs text-zinc-400">Run real-time on-page SEO audits on any test storefront URL.</p>
				</div>
				<Badge type="info">Sandbox Mode</Badge>
			</div>

			<Card>
				<div className="flex gap-2 mb-4">
					<input
						type="text"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						className="flex-1 px-3.5 py-2 rounded-xl bg-zinc-50 border border-zinc-200 text-xs font-mono focus:outline-none focus:border-zinc-900"
					/>
					<Button onClick={() => setAudited(true)}>Audit URL</Button>
				</div>

				{audited && (
					<div className="space-y-4 pt-4 border-t border-zinc-100">
						<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
							<StatCard title="SEO Score" value="96/100" />
							<StatCard title="Canonical Tag" value="Valid" />
							<StatCard title="Schema Markup" value="Product (Valid)" />
						</div>
						<div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs">
							✓ Passed: Title tag, H1 tag, Schema.org markup, and OpenGraph tags are valid.
						</div>
					</div>
				)}
			</Card>
		</div>
	);
}
