import React from 'react';
import { Search, Globe, Award } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '@saas/ui/cards/Card';
import { Button } from '@saas/ui/buttons/Button';

export default function GuestLanding() {
	return (
		<div className="space-y-6 max-w-4xl">
			<div className="text-center space-y-3 py-6">
				<h1 className="text-3xl font-extrabold text-zinc-950 tracking-tight">Autonomous SEO Engine</h1>
				<p className="text-sm text-zinc-500 max-w-lg mx-auto">
					Automate structured schema generation, dynamic XML sitemaps, and real-time on-page SEO audits.
				</p>
				<div className="flex justify-center gap-3 pt-2">
					<Link to="/">
						<Button>Launch SEO Console</Button>
					</Link>
					<Link to="/sandbox">
						<Button variant="secondary">Try Sandbox</Button>
					</Link>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<Card title="Dynamic XML Sitemaps">
					<p className="text-xs text-zinc-500">
						Auto-generated XML index files synced instantly when products are added or modified.
					</p>
				</Card>
				<Card title="JSON-LD Rich Snippets">
					<p className="text-xs text-zinc-500">
						Inject structured Product, Offer, and Organization schema markup for Google Rich Results.
					</p>
				</Card>
				<Card title="Meta Forensics">
					<p className="text-xs text-zinc-500">
						AI audits checking title lengths, canonical tags, and OpenGraph tags in real-time.
					</p>
				</Card>
			</div>
		</div>
	);
}
