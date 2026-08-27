import React from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Shield, Cpu, ArrowRight, Layers, BarChart3 } from 'lucide-react';

export default function LandingPage() {
	const highlights = [
		{
			icon: <Layers className="text-indigo-600" size={22} />,
			title: 'Modular SaaS Applications',
			desc: 'Autonomous micro-apps including AI Chatbot, SEO Engine, Analytics Pro, and Loyalty Rewards.',
		},
		{
			icon: <Cpu className="text-indigo-600" size={22} />,
			title: 'Edge Ingestion & Metering',
			desc: 'High-throughput event tracking measuring API calls, LLM tokens, and data volume per tenant.',
		},
		{
			icon: <Shield className="text-indigo-600" size={22} />,
			title: 'Cryptographic Isolation',
			desc: 'Strictly isolated merchant contexts, domain resolution, and role-based access control.',
		},
		{
			icon: <BarChart3 className="text-indigo-600" size={22} />,
			title: 'Central Billing Engine',
			desc: 'Automated invoice generation, tiered subscription plans, and real-time MRR analytics.',
		},
	];

	const plans = [
		{ name: 'Core', price: '$99', desc: 'Essential apps & standard analytics for emerging stores.' },
		{ name: 'Pro', price: '$450', desc: 'Full AI Chatbot, Automation, SEO Engine, and priority queues.', popular: true },
		{ name: 'Enterprise', price: '$1,200', desc: 'Full application suite, dedicated worker instances, and SLA.' },
	];

	return (
		<div className="max-w-6xl mx-auto space-y-12 pb-12 antialiased font-sans">
			{/* Hero Banner */}
			<div className="text-center py-16 px-6 rounded-2xl border border-slate-200/80 bg-white shadow-xs space-y-6 transition-all duration-200">
				<div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full border border-indigo-100 bg-indigo-50/70 text-indigo-700 text-xs font-semibold">
					<Sparkles size={14} className="text-indigo-600" />
					<span>Next-Generation Multi-Product SaaS Suite</span>
				</div>

				<h1 className="text-4xl md:text-5xl font-extrabold text-slate-900 tracking-tight max-w-3xl mx-auto">
					SingleSolution SaaS Control Plane
				</h1>

				<p className="text-slate-600 text-base md:text-lg max-w-2xl mx-auto leading-relaxed">
					The centralized operating system for independent multi-tenant SaaS products. Deploy modular apps, govern store
					operations, and track usage with zero friction.
				</p>

				<div className="flex flex-wrap items-center justify-center gap-3 pt-2">
					<Link
						to="/"
						className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-xs transition-all duration-150 shadow-xs hover:shadow-sm active:scale-98 flex items-center gap-2">
						Launch Admin Console <ArrowRight size={14} />
					</Link>
					<Link
						to="/merchant"
						className="px-5 py-2.5 rounded-xl bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-semibold text-xs transition-all duration-150 shadow-xs hover:border-slate-300 active:scale-98">
						Open Merchant Portal
					</Link>
				</div>
			</div>

			{/* Feature Grid */}
			<div className="space-y-4">
				<h2 className="text-lg font-bold text-slate-900 tracking-tight">Core Architecture</h2>
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
					{highlights.map((h, i) => (
						<div
							key={i}
							className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs hover:shadow-md hover:border-indigo-200 hover:-translate-y-0.5 transition-all duration-200 space-y-3">
							<div className="p-2 rounded-xl bg-indigo-50 border border-indigo-100 w-fit">{h.icon}</div>
							<h3 className="font-bold text-slate-900 text-sm">{h.title}</h3>
							<p className="text-xs text-slate-500 leading-relaxed">{h.desc}</p>
						</div>
					))}
				</div>
			</div>

			{/* Plans Matrix */}
			<div className="space-y-4">
				<h2 className="text-lg font-bold text-slate-900 tracking-tight">Subscription Tiers</h2>
				<div className="grid grid-cols-1 md:grid-cols-3 gap-6">
					{plans.map((p, i) => (
						<div
							key={i}
							className={`p-6 rounded-2xl border relative flex flex-col justify-between space-y-6 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 ${
								p.popular
									? 'bg-white border-indigo-600 shadow-sm ring-1 ring-indigo-600'
									: 'bg-white border-slate-200/80 shadow-xs'
							}`}>
							{p.popular && (
								<span className="absolute top-4 right-4 px-2.5 py-0.5 rounded-full bg-indigo-600 text-white text-[10px] font-bold uppercase tracking-wider">
									Popular
								</span>
							)}
							<div className="space-y-3">
								<h3 className="text-base font-bold text-slate-900">{p.name}</h3>
								<div className="text-3xl font-extrabold text-slate-900">
									{p.price} <span className="text-xs font-normal text-slate-500">/ month</span>
								</div>
								<p className="text-xs text-slate-600 leading-relaxed">{p.desc}</p>
							</div>

							<Link
								to="/tenants"
								className={`w-full py-2.5 text-center rounded-xl font-semibold text-xs transition-all duration-150 ${
									p.popular
										? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs hover:shadow-sm'
										: 'bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 shadow-xs hover:border-slate-300'
								}`}>
								Add Merchant
							</Link>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
