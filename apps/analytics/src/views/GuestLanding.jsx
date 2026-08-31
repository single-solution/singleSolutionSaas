import React from 'react';
import Link from 'next/link';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';

export default function GuestLanding() {
	return (
		<div className="space-y-6 max-w-4xl">
			<div className="text-center space-y-3 py-6">
				<h1 className="text-3xl font-extrabold text-zinc-950 tracking-tight">Analytics Pro Intelligence</h1>
				<p className="text-sm text-zinc-500 max-w-lg mx-auto">
					Ultra-low latency event collection, cohort retention analysis, and drop-off forensics for fast-growing merchants.
				</p>
				<div className="flex justify-center gap-3 pt-2">
					<Link href="/">
						<Button>Launch Analytics Hub</Button>
					</Link>
					<Link href="/sandbox">
						<Button variant="secondary">Live Sandbox</Button>
					</Link>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<Card title="Edge Telemetry">
					<p className="text-xs text-zinc-500">Sub-10ms global edge ingestion with zero impact on storefront page speed.</p>
				</Card>
				<Card title="Funnel Forensics">
					<p className="text-xs text-zinc-500">Pinpoint exactly which step causes customer checkout abandonments.</p>
				</Card>
				<Card title="Cohort LTV">
					<p className="text-xs text-zinc-500">
						Automatic recurring cohort matrices to monitor customer retention across months.
					</p>
				</Card>
			</div>
		</div>
	);
}
