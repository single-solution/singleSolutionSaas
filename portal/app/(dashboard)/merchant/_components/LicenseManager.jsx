'use client';

import React, { useState } from 'react';
import { usePortal } from '../../../../context/PortalContext';
import { Sliders, ShieldCheck, Check, AlertCircle, Sparkles, Layers, Zap, Globe, Coins } from 'lucide-react';

export default function LicenseManager() {
	const {
		activeTenant,
		products = [],
		toggleWebsiteFeature,
		calculateMerchantMonthlyFee,
		calculateWebsiteMonthlyFee,
	} = usePortal();

	const websites =
		Array.isArray(activeTenant?.websites) && activeTenant.websites.length > 0
			? activeTenant.websites
			: [
					{
						id: 'primary',
						name: activeTenant?.name || 'Primary Store',
						domain: activeTenant?.domain || 'primary.com',
						subscriptions: activeTenant?.subscriptions || {},
					},
				];

	const [selectedWebsiteId, setSelectedWebsiteId] = useState(websites[0]?.id || 'primary');

	const currentSite = websites.find((w) => w.id === selectedWebsiteId) || websites[0];
	const totalMerchantBurn = calculateMerchantMonthlyFee(activeTenant);
	const siteMonthlyBurn = calculateWebsiteMonthlyFee(currentSite);
	const currentBalance = Number(activeTenant?.creditsBalance) || 0;
	const isLowBalance = currentBalance < totalMerchantBurn;

	return (
		<div className="space-y-6 max-w-4xl">
			{/* Top Header & Float Summary */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
				<div>
					<h1 className="text-xl font-bold text-slate-900 tracking-tight">Active Module Feature Licenses</h1>
					<p className="text-xs text-slate-500">
						Configure micro-app features and observe auto-calculated monthly credit consumption per website
					</p>
				</div>
				<div className="p-3 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex items-center gap-4 text-xs">
					<div>
						<div className="text-[10px] text-slate-400 font-bold uppercase">Total Store Monthly Float</div>
						<div className="font-extrabold text-indigo-600 text-base">${totalMerchantBurn} / mo</div>
					</div>
					<div className="h-8 w-px bg-slate-100" />
					<div>
						<div className="text-[10px] text-slate-400 font-bold uppercase">Current Float</div>
						<div className={`font-extrabold text-base ${isLowBalance ? 'text-rose-600' : 'text-slate-900'}`}>
							${currentBalance}
						</div>
					</div>
				</div>
			</div>

			{isLowBalance && (
				<div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-center gap-3">
					<AlertCircle size={18} className="text-amber-600 shrink-0" />
					<div>
						<strong className="font-bold">Low Wallet Balance Alert:</strong> Your store wallet has ${currentBalance}, which
						is lower than your active monthly license usage of ${totalMerchantBurn}/mo. Top up your balance in the Billing
						tab to prevent service interruptions.
					</div>
				</div>
			)}

			{/* Website Selector Tabs */}
			<div className="space-y-2">
				<div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Select Storefront Website</div>
				<div className="flex flex-wrap gap-2">
					{websites.map((site) => {
						const isSelected = (selectedWebsiteId || websites[0]?.id) === site.id;
						const siteCost = calculateWebsiteMonthlyFee(site);

						return (
							<button
								key={site.id}
								type="button"
								onClick={() => setSelectedWebsiteId(site.id)}
								className={`px-4 py-2.5 rounded-xl border text-xs text-left transition-all cursor-pointer ${
									isSelected
										? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
										: 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
								}`}>
								<div className="font-bold flex items-center gap-1.5">
									<Globe size={13} className={isSelected ? 'text-white' : 'text-indigo-600'} />
									<span>{site.name}</span>
								</div>
								<div className={`text-[10px] ${isSelected ? 'text-indigo-200' : 'text-slate-400'}`}>
									{site.domain} · ${siteCost} credits/mo
								</div>
							</button>
						);
					})}
				</div>
			</div>

			{/* Active Website Banner */}
			<div className="p-3.5 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-between">
				<div>
					<span className="font-bold text-xs text-indigo-950">
						Managing Website: {currentSite?.name} ({currentSite?.domain})
					</span>
					<span className="text-[11px] text-slate-500 block">Toggling modules here applies strictly to this domain.</span>
				</div>
				<div className="text-right">
					<span className="text-xs font-bold text-slate-400 uppercase">Website Subtotal</span>
					<div className="text-base font-black text-indigo-600">
						${siteMonthlyBurn} <span className="text-xs font-normal text-slate-500">/mo</span>
					</div>
				</div>
			</div>

			{/* Micro-App Feature Matrix */}
			<div className="space-y-4">
				{products.map((prod) => {
					const activeFeatures = currentSite?.subscriptions?.[prod.id] || [];
					const appTotal = (prod.features || []).reduce(
						(sum, f) => (activeFeatures.includes(f.id) ? sum + (f.creditCost || 0) : sum),
						0,
					);

					return (
						<div key={prod.id} className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-4">
							<div className="flex items-center justify-between pb-3 border-b border-slate-100">
								<div className="flex items-center gap-3">
									<div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-xs">
										<Layers size={16} />
									</div>
									<div>
										<h3 className="font-bold text-sm text-slate-900">{prod.name}</h3>
										<p className="text-[11px] text-slate-400">{prod.desc || prod.description}</p>
									</div>
								</div>
								<div className="flex items-center gap-2">
									<span className="text-xs font-bold text-indigo-600">${appTotal}/mo</span>
										<span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">
											v1.0
										</span>
								</div>
							</div>

							<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
								{prod.features?.map((feat) => {
									const isEnabled = activeFeatures.includes(feat.id);
									return (
										<button
											key={feat.id}
											type="button"
											onClick={() => {
												if (activeTenant && currentSite) {
													toggleWebsiteFeature(activeTenant.id, currentSite.id, prod.id, feat.id);
												}
											}}
											className={`p-3 rounded-xl border text-left flex flex-col justify-between space-y-2 transition-all cursor-pointer ${
												isEnabled
													? 'bg-indigo-50/40 border-indigo-200 text-indigo-950 shadow-2xs'
													: 'bg-slate-50 border-slate-200/60 text-slate-400 hover:border-slate-300'
											}`}>
											<div className="flex items-start justify-between gap-2">
												<div className="font-bold text-xs">{feat.name}</div>
												<span
													className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase ${
														isEnabled ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'
													}`}>
													{isEnabled ? 'Active' : 'Off'}
												</span>
											</div>
											<div className="text-[11px] text-slate-500">{feat.desc}</div>
											<div className="text-[10px] font-bold text-indigo-700 pt-1 border-t border-slate-200/40">
												${feat.creditCost} credits / month
											</div>
										</button>
									);
								})}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
