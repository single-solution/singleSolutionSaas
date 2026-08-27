import React from 'react';
import { Zap, GitBranch, Bell } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';

export default function GuestLanding() {
	return (
		<div className="space-y-6 max-w-4xl">
			<div className="text-center space-y-3 py-6">
				<h1 className="text-3xl font-extrabold text-zinc-950 tracking-tight">Workflow Automation Engine</h1>
				<p className="text-sm text-zinc-500 max-w-lg mx-auto">
					Trigger webhooks, send instant customer alerts, and sync data between third-party services in real-time.
				</p>
				<div className="flex justify-center gap-3 pt-2">
					<Link to="/">
						<Button>Launch Automation Hub</Button>
					</Link>
					<Link to="/sandbox">
						<Button variant="secondary">Try Sandbox</Button>
					</Link>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<Card title="Event-Driven Pipelines">
					<p className="text-xs text-zinc-500">
						Subscribe to any store event (order created, refunded, customer tagged) instantly.
					</p>
				</Card>
				<Card title="Multi-Channel Actions">
					<p className="text-xs text-zinc-500">
						Send notifications to Slack, Discord, WhatsApp, Email, or custom HTTP webhooks.
					</p>
				</Card>
				<Card title="Zero Infrastructure">
					<p className="text-xs text-zinc-500">
						Executes on serverless Vercel Edge functions with sub-20ms latency and 99.9% uptime.
					</p>
				</Card>
			</div>
		</div>
	);
}
