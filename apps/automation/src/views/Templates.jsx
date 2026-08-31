import React from 'react';
import Link from 'next/link';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Badge } from '@saas/ui/badges/Badge';

export default function Templates() {
	const templates = [
		{
			title: 'Slack Sales Notification',
			desc: 'Instantly notify team channels whenever high-value orders are placed.',
			tag: 'Popular',
		},
		{ title: 'Order Confirmation Email', desc: 'Send branded receipt HTML with real-time tracking links.', tag: 'Essential' },
		{
			title: 'Low Stock WhatsApp Alert',
			desc: 'Trigger automated WhatsApp messages to warehouse managers when SKU drops below 5.',
			tag: 'Inventory',
		},
	];

	return (
		<div className="space-y-6">
			<PageHeader
				title="Workflow Starter Blueprints"
				subtitle="Pre-built triggers and actions designed for common commerce lifecycle events"
			/>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				{templates.map((t, i) => (
					<Card key={i} title={t.title}>
						<div className="space-y-4">
							<Badge type="info">{t.tag}</Badge>
							<p className="text-xs text-zinc-500">{t.desc}</p>
							<Link href="/builder">
								<Button variant="secondary" size="sm">
									Use Template
								</Button>
							</Link>
						</div>
					</Card>
				))}
			</div>
		</div>
	);
}
