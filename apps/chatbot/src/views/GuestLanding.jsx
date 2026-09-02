'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { Bot, Sparkles, Building2, Globe, Shield, Terminal, Zap, ArrowUpRight, Activity, CheckCircle2 } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Button } from '@saas/ui/buttons/Button';
import { Badge } from '@saas/ui/badges/Badge';
import { DataTable } from '@saas/ui/tables/Table';
import { useAppContext } from '../context/AppContext';

export default function GuestLanding() {
	const { portalUrl, session } = useAppContext() || {};
	const [tenants, setTenants] = useState([]);
	const [features, setFeatures] = useState([]);

	useEffect(() => {
		const pUrl =
			(typeof window !== 'undefined' && window.__PORTAL_URL__) ||
			session?.portalUrl ||
			portalUrl ||
			process.env.NEXT_PUBLIC_PORTAL_URL ||
			'';
		if (pUrl) {
			fetch(`${pUrl}/api/tenants`)
				.then((res) => res.json())
				.then((data) => {
					if (Array.isArray(data)) setTenants(data);
				})
				.catch(() => {});
		}

		fetch('/api/features')
			.then((res) => res.json())
			.then((data) => {
				if (Array.isArray(data?.features)) setFeatures(data.features);
			})
			.catch(() => {});
	}, [portalUrl, session]);

	const totalMerchants = tenants.length || 3;
	const totalWebsites = tenants.reduce((acc, t) => acc + (t.websites?.length || 1), 0) || 5;

	return (
		<div className="space-y-6 max-w-6xl pb-12">
			<PageHeader
				title="AI Chatbot Engine • Operations Hub"
				subtitle="Global operational status, connected merchant statistics, hourly feature pricing, and direct API connect"
				actions={
					<div className="flex items-center gap-2">
						<Link href="/features">
							<Button variant="secondary" size="sm">
								<Zap size={13} />
								<span>Feature Pricing</span>
							</Button>
						</Link>
						<a href={portalUrl || 'http://localhost:5000'}>
							<Button size="sm">
								<span>Master Portal Login</span>
								<ArrowUpRight size={13} />
							</Button>
						</a>
					</div>
				}
			/>

			{/* Operational Stats Radar */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard title="Connected Merchants" value={totalMerchants.toString()} trend="Active Subscriptions" />
				<StatCard title="Active Storefront Websites" value={totalWebsites.toString()} trend="Live Embedded Scripts" />
				<StatCard title="Conversations Handled (24h)" value="1,420" trend="+18.4% volume" />
				<StatCard title="AI Intent Resolution Rate" value="94.2%" trend="Grade A+" />
			</div>

			{/* Connected Merchants Directory */}
			<Card title="Connected Merchant Storefronts & Websites">
				<DataTable
					columns={[
						{
							key: 'name',
							label: 'Merchant Brand',
							render: (v, r) => (
								<div className="flex items-center gap-2.5">
									<div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-700 flex items-center justify-center font-bold text-xs">
										<Building2 size={15} />
									</div>
									<div>
										<div className="font-bold text-slate-900 text-xs">{v || r.id}</div>
										<div className="text-[10px] font-mono text-slate-400">{r.domain || 'custom domain'}</div>
									</div>
								</div>
							),
						},
						{
							key: 'websites',
							label: 'Associated Websites',
							render: (v) => (
								<div className="flex flex-wrap gap-1">
									{(v || [{ name: 'Main Store' }]).map((w, i) => (
										<span
											key={i}
											className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-semibold text-[10px]">
											{w.name || w.domain}
										</span>
									))}
								</div>
							),
						},
						{
							key: 'status',
							label: 'Operational Status',
							render: (v) => <Badge type={v === 'active' ? 'active' : 'neutral'}>{v || 'Active'}</Badge>,
						},
						{
							key: 'id',
							label: 'Tenant Key',
							render: (v) => <span className="font-mono text-xs text-slate-500">{v}</span>,
						},
					]}
					data={
						tenants.length > 0
							? tenants
							: [
									{
										id: 'tnt_chandni',
										name: 'Chandni Traders',
										domain: 'chandnitraders.com',
										status: 'active',
										websites: [{ name: 'Chandni Retail' }, { name: 'Chandni Wholesale' }],
									},
									{
										id: 'tnt_ibrahim',
										name: 'Ibrahim Mobiles',
										domain: 'ibrahimmobiles.com',
										status: 'active',
										websites: [{ name: 'Tech Store' }],
									},
									{
										id: 'tnt_sisters',
										name: 'Sisters Boutique',
										domain: 'sistersboutique.com',
										status: 'active',
										websites: [{ name: 'Boutique Pret' }, { name: 'Outlet Store' }],
									},
								]
					}
				/>
			</Card>

			{/* Global Hourly Pricing Rules */}
			<Card title="Autonomous Feature Licensing & Hourly Pricing Matrix">
				<div className="space-y-3">
					<p className="text-xs text-slate-500">
						Features are priced per active hour and billed automatically to subscribed merchants.
					</p>
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
						{(features.length > 0
							? features
							: [
									{ id: 'conversations', name: 'Live Support Conversations', hourlyPrice: 0.007, category: 'Core' },
									{
										id: 'knowledge_base',
										name: 'Knowledge Base Vector RAG',
										hourlyPrice: 0.012,
										category: 'Intelligence',
									},
									{ id: 'handoff', name: 'Human Agent Escalation', hourlyPrice: 0.005, category: 'Omnichannel' },
								]
						).map((f) => (
							<div key={f.id} className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
								<div className="flex items-center justify-between">
									<span className="font-bold text-xs text-slate-800">{f.name}</span>
									<Badge type="pro">${f.hourlyPrice}/hr</Badge>
								</div>
								<div className="text-[11px] text-slate-500">
									Feature Key: <code className="font-mono text-indigo-600">{f.id}</code>
								</div>
							</div>
						))}
					</div>
				</div>
			</Card>
		</div>
	);
}
