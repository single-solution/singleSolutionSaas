'use client';

import React, { useState } from 'react';
import { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';
import {
	Activity,
	TrendingUp,
	ShoppingBag,
	Zap,
	Search,
	AlertTriangle,
	Share2,
	BarChart2,
	Webhook,
	Check,
	Coins,
	ShieldCheck,
	Sparkles,
	Layers,
	Store,
	ExternalLink,
	Clock,
} from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Badge } from '@saas/ui/badges/Badge';
import { useStorefront } from '../context/StorefrontContext';
import { formatHourlyRate, formatMonthlyEquivalent, getHourlyRate } from '@saas/ui/billing/hourlyBilling';

const ICON_MAP = {
	Activity,
	TrendingUp,
	ShoppingBag,
	Zap,
	Search,
	AlertTriangle,
	Share2,
	BarChart2,
	Webhook,
};

export default function FeatureManager() {
	const { session, portalUrl } = useAppSecurity() || {};
	const effectivePortal = portalUrl || session?.portalUrl || '';
	const billingLink = effectivePortal
		? `${effectivePortal}/${session?.role === 'merchant' ? 'merchant/billing' : 'admin/billing'}`
		: '#';
	const { activeStore, enabledFeatures, featuresCatalog, totalMonthlyCost, toggleFeature, isAdmin, refreshStoreData } =
		useStorefront();
	const [filterCategory, setFilterCategory] = useState('all');

	const [editingFeature, setEditingFeature] = useState(null);
	const [newCreditCost, setNewCreditCost] = useState('');
	const [isSavingPricing, setIsSavingPricing] = useState(false);

	if (!activeStore) {
		return (
			<div className="space-y-6 antialiased text-slate-900">
				<PageHeader
					title="Module & Feature Governance"
					subtitle="Enable, disable, and allocate analytics capabilities per merchant storefront"
				/>
				<Card>
					<div className="py-16 text-center text-xs text-slate-400 space-y-2">
						<Store size={32} className="mx-auto text-slate-300" />
						<p className="font-bold text-slate-600">No merchant storefront connected</p>
						<p>Launch Analytics Pro from your Master SaaS Portal to manage feature licenses.</p>
					</div>
				</Card>
			</div>
		);
	}

	const categories = ['all', 'Traffic', 'E-Commerce', 'Performance', 'Intelligence', 'Diagnostics', 'Integrations'];

	const filteredFeatures = featuresCatalog.filter((f) => {
		return filterCategory === 'all' || f.category === filterCategory;
	});

	const activeCount = featuresCatalog.filter((f) => enabledFeatures.includes(f.id)).length;
	const totalHourlyBurn = getHourlyRate(totalMonthlyCost).toFixed(4);

	const handleSavePricing = async (e) => {
		e.preventDefault();
		if (!editingFeature) return;
		setIsSavingPricing(true);
		try {
			const res = await fetch('/api/features', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					featureId: editingFeature.id,
					newCreditCost: Number(newCreditCost),
				}),
			});
			if (res.ok) {
				setEditingFeature(null);
				// Force a refresh of the store data to get updated features
				if (typeof refreshStoreData === 'function') refreshStoreData();
				else window.location.reload();
			} else {
				alert('Failed to update pricing');
			}
		} catch (err) {
			alert('Error updating pricing');
		} finally {
			setIsSavingPricing(false);
		}
	};

	return (
		<div className="space-y-6 antialiased text-slate-900">
			<PageHeader
				title="Module & Feature Governance"
				subtitle={`Configure subscribed capabilities with AWS-style hourly metering for ${activeStore.name} (${activeStore.domain})`}
			/>

			{/* Overview Banner */}
			<div className="p-6 rounded-3xl bg-linear-to-r from-slate-900 via-indigo-950 to-slate-900 text-white shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
				<div className="space-y-2">
					<div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md text-[11px] font-bold text-indigo-300">
						<Store size={13} />
						<span>Storefront: {activeStore.name}</span>
						<span className="text-slate-400">({activeStore.domain})</span>
					</div>
					<h2 className="text-xl font-extrabold tracking-tight">Active Analytics Capabilities</h2>
					<p className="text-xs text-slate-300 max-w-xl leading-relaxed">
						<strong>AWS-Style Pay-Per-Hour Metering:</strong> Turn features ON for campaigns or flash sales and turn them
						OFF anytime. You are only billed for the exact hours a capability is enabled.
					</p>
				</div>

				<div className="flex items-center gap-4 bg-white/5 border border-white/10 p-4 rounded-2xl">
					<div className="text-right">
						<div className="text-[11px] text-slate-400 font-bold uppercase flex items-center justify-end gap-1">
							<Clock size={11} className="text-amber-400" />
							<span>Hourly Burn Rate</span>
						</div>
						<div className="text-2xl font-black text-amber-400 flex items-center gap-1 justify-end">
							<span>${totalHourlyBurn}</span>
							<span className="text-xs text-slate-300 font-normal">/hr</span>
						</div>
						<div className="text-[10px] text-slate-400">~${totalMonthlyCost}/month full float</div>
					</div>
					<div className="h-10 w-px bg-white/10" />
					<div className="text-left">
						<div className="text-[11px] text-slate-400 font-bold uppercase">Active Modules</div>
						<div className="text-2xl font-black text-emerald-400">
							{activeCount} <span className="text-xs text-slate-300 font-normal">/ {featuresCatalog.length}</span>
						</div>
						<div className="text-[10px] text-emerald-300/80">Metered Live</div>
					</div>
				</div>
			</div>

			{/* Filter Tabs */}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap gap-1.5 p-1 bg-slate-100/80 border border-slate-200/80 rounded-xl">
					{categories.map((cat) => (
						<button
							key={cat}
							type="button"
							onClick={() => setFilterCategory(cat)}
							className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
								filterCategory === cat ? 'bg-white text-indigo-700 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
							}`}>
							{cat.charAt(0).toUpperCase() + cat.slice(1)}
						</button>
					))}
				</div>

				<a
					href={billingLink}
					className="inline-flex items-center gap-1.5 text-xs font-bold text-indigo-600 hover:text-indigo-800">
					<span>Manage Wallet Top-Ups in Portal</span>
					<ExternalLink size={13} />
				</a>
			</div>

			{/* Features Grid */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{filteredFeatures.map((feat) => {
					const isEnabled = enabledFeatures.includes(feat.id);
					const IconComponent = ICON_MAP[feat.icon] || Activity;
					const hourlyPrice = formatHourlyRate(feat.creditCost);
					const monthlyApprox = formatMonthlyEquivalent(feat.creditCost);

					return (
						<div
							key={feat.id}
							className={`p-5 rounded-2xl border transition-all flex flex-col justify-between space-y-4 ${
								isEnabled
									? 'bg-white border-indigo-200/80 shadow-xs ring-1 ring-indigo-500/10'
									: 'bg-slate-50/70 border-slate-200/60 opacity-80'
							}`}>
							<div className="space-y-3">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2.5">
										<div
											className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm ${
												isEnabled ? 'bg-indigo-600 text-white shadow-xs' : 'bg-slate-200 text-slate-500'
											}`}>
											<IconComponent size={18} />
										</div>
										<div>
											<h3 className="font-bold text-xs text-slate-900 leading-tight">{feat.name}</h3>
											<span className="text-[10px] text-slate-400 font-medium">{feat.category}</span>
										</div>
									</div>

									<span
										className={`px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider ${
											isEnabled
												? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
												: 'bg-slate-200 text-slate-600'
										}`}>
										{isEnabled ? 'Active' : 'Disabled'}
									</span>
								</div>

								<p className="text-xs text-slate-500 leading-relaxed">{feat.desc}</p>
							</div>

							<div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
								<div>
									<div className="flex items-baseline gap-1">
										<span className="font-extrabold text-sm text-indigo-600">{hourlyPrice}</span>
									</div>
									<span className="text-[10px] text-slate-400 block font-mono">{monthlyApprox} equivalent</span>
								</div>

								<div className="flex items-center gap-2">
									{isAdmin && (
										<button
											type="button"
											onClick={() => {
												setEditingFeature(feat);
												setNewCreditCost(feat.creditCost);
											}}
											className="px-2 py-1.5 rounded-xl font-bold text-[10px] transition-all bg-slate-100 hover:bg-slate-200 text-slate-600 cursor-pointer">
											Edit Pricing
										</button>
									)}
									<button
										type="button"
										onClick={() => toggleFeature(feat.id, isEnabled ? 'disable' : 'enable')}
										className={`px-3.5 py-1.5 rounded-xl font-bold text-xs transition-all shadow-2xs cursor-pointer ${
											isEnabled
												? 'bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200'
												: 'bg-indigo-600 hover:bg-indigo-700 text-white'
										}`}>
										{isEnabled ? 'Turn Off' : 'Enable ($/hr)'}
									</button>
								</div>
							</div>
						</div>
					);
				})}
			</div>

			{/* Admin Edit Pricing Modal */}
			{editingFeature && (
				<div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
					<div className="w-full max-w-md bg-white rounded-2xl p-6 shadow-2xl animate-in zoom-in-95 fade-in duration-200">
						<h3 className="text-sm font-bold text-slate-900 mb-4 flex items-center justify-between">
							<span>Admin Override Pricing</span>
							<button onClick={() => setEditingFeature(null)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</h3>
						<form onSubmit={handleSavePricing} className="space-y-4">
							<div className="space-y-1">
								<label className="text-[11px] font-bold text-slate-700 uppercase">Feature</label>
								<div className="text-sm font-bold text-slate-900">{editingFeature.name}</div>
							</div>
							<div className="space-y-1">
								<label className="text-[11px] font-bold text-slate-700 uppercase">Monthly Credit Cost (Base)</label>
								<input
									type="number"
									required
									min="0"
									value={newCreditCost}
									onChange={(e) => setNewCreditCost(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 outline-none focus:border-indigo-500 font-mono text-sm"
								/>
								<div className="text-[10px] text-slate-500 pt-1">
									This sets the new base rate which is automatically converted to the{' '}
									<strong className="text-indigo-600">
										{newCreditCost ? formatHourlyRate(newCreditCost) : '$0.0000/hr'}
									</strong>{' '}
									hourly rate.
								</div>
							</div>
							<div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100">
								<button
									type="button"
									onClick={() => setEditingFeature(null)}
									className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200">
									Cancel
								</button>
								<button
									type="submit"
									disabled={isSavingPricing}
									className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 text-white hover:bg-indigo-700 shadow-xs disabled:opacity-50">
									{isSavingPricing ? 'Saving...' : 'Save Pricing'}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
