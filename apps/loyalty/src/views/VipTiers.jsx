import React from 'react';
import { Plus } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';

export default function VipTiers() {
	const tiers = [
		{
			name: 'Bronze Explorer',
			minSpend: '$0',
			multiplier: '1x Points',
			perks: 'Birthday Gift, Member Newsletter',
			count: '3,120 members',
		},
		{
			name: 'Silver Insider',
			minSpend: '$500',
			multiplier: '1.5x Points',
			perks: 'Free Express Shipping, Early Sale Access',
			count: '1,240 members',
		},
		{
			name: 'Gold Luminary',
			minSpend: '$1,500',
			multiplier: '2x Points',
			perks: 'Dedicated Concierge, Free Returns, Exclusive Drops',
			count: '461 members',
		},
	];

	return (
		<div className="space-y-6">
			<PageHeader
				title="VIP Membership Tiers"
				subtitle="Tier qualification criteria, point earning multipliers, and exclusive perks"
				actions={
					<Button size="sm">
						<Plus size={13} />
						<span>Add New Tier</span>
					</Button>
				}
			/>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				{tiers.map((t, i) => (
					<Card key={i} title={t.name}>
						<div className="space-y-3 text-xs">
							<div className="flex justify-between items-center pb-2 border-b border-zinc-100">
								<span className="text-zinc-500">Spend Threshold</span>
								<strong className="text-zinc-900">{t.minSpend}</strong>
							</div>
							<div className="flex justify-between items-center pb-2 border-b border-zinc-100">
								<span className="text-zinc-500">Multiplier</span>
								<Badge type="pro">{t.multiplier}</Badge>
							</div>
							<div>
								<span className="text-zinc-400 block text-[10px] uppercase font-bold mb-1">Perks</span>
								<p className="text-zinc-700">{t.perks}</p>
							</div>
							<div className="pt-2 text-[10px] text-zinc-400 font-mono">{t.count}</div>
						</div>
					</Card>
				))}
			</div>
		</div>
	);
}
