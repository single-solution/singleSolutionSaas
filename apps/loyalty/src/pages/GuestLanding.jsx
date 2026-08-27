import React from 'react';
import { Gift, Award, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';

export default function GuestLanding() {
	return (
		<div className="space-y-6 max-w-4xl">
			<div className="text-center space-y-3 py-6">
				<h1 className="text-3xl font-extrabold text-zinc-950 tracking-tight">Loyalty & Rewards Program</h1>
				<p className="text-sm text-zinc-500 max-w-lg mx-auto">
					Reward repeat purchases, incentivize VIP status, and drive sustainable customer lifetime value.
				</p>
				<div className="flex justify-center gap-3 pt-2">
					<Link to="/">
						<Button>Launch Loyalty Hub</Button>
					</Link>
					<Link to="/sandbox">
						<Button variant="secondary">Try Sandbox</Button>
					</Link>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<Card title="VIP Multipliers">
					<p className="text-xs text-zinc-500">
						Tiered point multipliers that accelerate customer progression towards loyalty status.
					</p>
				</Card>
				<Card title="Redemption Store">
					<p className="text-xs text-zinc-500">
						Self-service catalog where customers convert accrued points into store vouchers.
					</p>
				</Card>
				<Card title="Order Sync">
					<p className="text-xs text-zinc-500">
						Real-time webhook sync ensuring points are calculated and credited upon order capture.
					</p>
				</Card>
			</div>
		</div>
	);
}
