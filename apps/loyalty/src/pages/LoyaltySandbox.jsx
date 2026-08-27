import React, { useState } from 'react';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Badge } from '@saas/ui/badges/Badge';
import { StatCard } from '@saas/ui/cards/StatCard';

export default function LoyaltySandbox() {
	const [points, setPoints] = useState(1200);

	return (
		<div className="space-y-6 max-w-3xl">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-zinc-950">Loyalty Points Sandbox</h1>
					<p className="text-xs text-zinc-400">
						Simulate point calculations, VIP multiplier upgrades, and voucher redemptions.
					</p>
				</div>
				<Badge type="info">Sandbox Mode</Badge>
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard title="Simulated Balance" value={`${points.toLocaleString()} pts`} />
				<StatCard title="Tier Progress" value="Gold (60%)" />
				<StatCard title="Value in Vouchers" value={`$${(points / 25).toFixed(2)}`} />
			</div>

			<Card title="Test Actions">
				<div className="flex flex-wrap gap-2">
					<Button size="sm" onClick={() => setPoints((p) => p + 100)}>
						Simulate $10 Spend (+100 pts)
					</Button>
					<Button size="sm" variant="secondary" onClick={() => setPoints((p) => p + 500)}>
						Simulate $50 Spend (+500 pts)
					</Button>
					<Button size="sm" variant="danger" disabled={points < 250} onClick={() => setPoints((p) => p - 250)}>
						Claim $10 Voucher (-250 pts)
					</Button>
				</div>
			</Card>
		</div>
	);
}
