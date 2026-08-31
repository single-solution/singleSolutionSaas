import React from 'react';
import Link from 'next/link';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';
import { Badge } from '@saas/ui/badges/Badge';

export default function GuestLanding() {
	return (
		<div className="space-y-6 max-w-4xl">
			<div className="text-center space-y-3 py-6">
				<Badge type="pro">SaaS App • Port 5002</Badge>
				<h1 className="text-3xl font-extrabold text-zinc-950 tracking-tight">AI Customer Support Chatbot</h1>
				<p className="text-sm text-zinc-500 max-w-lg mx-auto">
					Autonomous conversational agent that hooks directly into your storefront order systems and knowledge base.
				</p>
				<div className="flex justify-center gap-3 pt-2">
					<Link href="/">
						<Button>Launch Merchant Console</Button>
					</Link>
					<Link href="/sandbox">
						<Button variant="secondary">Try Live Sandbox</Button>
					</Link>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<Card title="Order Lookup Actions">
					<p className="text-xs text-zinc-500">
						Autonomous lookup of real-time tracking numbers, courier dispatches, and inventory statuses.
					</p>
				</Card>
				<Card title="Knowledge Base Ingestion">
					<p className="text-xs text-zinc-500">
						RAG-powered vector search across return policies, sizing charts, and brand FAQs.
					</p>
				</Card>
				<Card title="Human Escalation">
					<p className="text-xs text-zinc-500">
						Instant handoff to WhatsApp, Zendesk, or custom support webhooks upon sentiment drop.
					</p>
				</Card>
			</div>
		</div>
	);
}
