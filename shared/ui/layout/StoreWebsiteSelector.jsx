'use client';

import React from 'react';
import { Building2, Globe, Shield, ExternalLink, ChevronDown } from 'lucide-react';

export function StoreWebsiteSelector({
	merchants = [],
	selectedMerchantId = '',
	onSelectMerchant,
	websites = [],
	selectedWebsiteId = '',
	onSelectWebsite,
	isAdmin = false,
	isMerchant = false,
	isStandalone = false,
	portalUrl = '',
	merchantName = '',
}) {
	if (isStandalone) {
		return (
			<div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-indigo-50 border border-indigo-200/80 text-indigo-900 text-xs font-semibold">
				<Shield size={14} className="text-indigo-600" />
				<span>Standalone Developer Mode</span>
				<span className="text-[10px] bg-indigo-200/70 text-indigo-800 px-1.5 py-0.5 rounded-md font-bold uppercase">
					Global
				</span>
			</div>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-2 text-xs">
			{/* 1. Merchant Selector (Interactive for Admin, Pill for Merchant) */}
			{isAdmin ? (
				<div className="relative flex items-center">
					<div className="absolute left-2.5 pointer-events-none text-slate-500">
						<Building2 size={14} />
					</div>
					<select
						value={selectedMerchantId}
						onChange={(e) => onSelectMerchant && onSelectMerchant(e.target.value)}
						className="pl-8 pr-7 py-1.5 rounded-xl bg-slate-50 hover:bg-slate-100/80 border border-slate-200 text-slate-800 font-bold text-xs appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all">
						{merchants.length === 0 ? (
							<option value="">No Merchants Found</option>
						) : (
							merchants.map((m) => (
								<option key={m.id} value={m.id}>
									{m.name || m.id}
								</option>
							))
						)}
					</select>
					<div className="absolute right-2 pointer-events-none text-slate-400">
						<ChevronDown size={13} />
					</div>
				</div>
			) : (
				<div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 border border-slate-200 text-slate-800 font-bold text-xs">
					<Building2 size={14} className="text-slate-500" />
					<span>{merchantName || 'Merchant Storefront'}</span>
				</div>
			)}

			{/* 2. Website / Storefront Selector (For Both Admin and Merchant) */}
			{websites && websites.length > 0 ? (
				<div className="relative flex items-center">
					<div className="absolute left-2.5 pointer-events-none text-indigo-600">
						<Globe size={14} />
					</div>
					<select
						value={selectedWebsiteId}
						onChange={(e) => onSelectWebsite && onSelectWebsite(e.target.value)}
						className="pl-8 pr-7 py-1.5 rounded-xl bg-indigo-50/60 hover:bg-indigo-50 border border-indigo-200 text-indigo-950 font-bold text-xs appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all">
						{websites.map((w) => (
							<option key={w.id} value={w.id}>
								{w.name} ({w.domain || 'custom domain'})
							</option>
						))}
					</select>
					<div className="absolute right-2 pointer-events-none text-indigo-400">
						<ChevronDown size={13} />
					</div>
				</div>
			) : (
				<div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-500 text-xs">
					<Globe size={14} />
					<span>Default Website</span>
				</div>
			)}

			{isAdmin && (
				<span className="hidden sm:inline-block text-[10px] px-2 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-800 font-extrabold uppercase tracking-wider">
					Admin Inspector
				</span>
			)}
		</div>
	);
}
