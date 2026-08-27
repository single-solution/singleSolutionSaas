import React, { useState } from 'react';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Badge } from '@saas/ui/badges/Badge';
import { StatCard } from '@saas/ui/cards/StatCard';

export default function AutomationSandbox() {
	const [runs, setRuns] = useState([]);

	const testFire = (event) => {
		const newRun = {
			event,
			action: 'Slack Notification + Email Dispatched',
			duration: '14ms',
			time: new Date().toLocaleTimeString(),
		};
		setRuns((prev) => [newRun, ...prev]);
	};

	return (
		<div className="space-y-6 max-w-3xl">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-zinc-950">Automation Event Simulator</h1>
					<p className="text-xs text-zinc-400">Trigger test webhook payloads and observe real-time action executions.</p>
				</div>
				<Badge type="info">Sandbox Mode</Badge>
			</div>

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard title="Simulated Invocations" value={runs.length} />
				<StatCard title="Worker Engine" value="Ready" />
				<StatCard title="Average Latency" value="14ms" />
			</div>

			<Card title="Trigger Test Store Events">
				<div className="flex flex-wrap gap-2 mb-4">
					<Button size="sm" onClick={() => testFire('order.paid')}>
						Fire 'order.paid'
					</Button>
					<Button size="sm" variant="secondary" onClick={() => testFire('customer.created')}>
						Fire 'customer.created'
					</Button>
					<Button size="sm" variant="secondary" onClick={() => testFire('stock.low')}>
						Fire 'stock.low'
					</Button>
				</div>

				<div className="space-y-2 max-h-48 overflow-y-auto">
					{runs.map((r, i) => (
						<div
							key={i}
							className="p-2.5 rounded-xl bg-zinc-50 border border-zinc-100 flex items-center justify-between text-xs font-mono">
							<span className="font-bold text-zinc-900">{r.event}</span>
							<span className="text-emerald-700">{r.action}</span>
							<span className="text-zinc-400">
								{r.time} ({r.duration})
							</span>
						</div>
					))}
				</div>
			</Card>
		</div>
	);
}
