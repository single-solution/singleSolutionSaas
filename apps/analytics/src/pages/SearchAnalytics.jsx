import React, { useState } from 'react';
import { Search, AlertCircle, CheckCircle2, TrendingUp, Sparkles, Filter, ShoppingBag, ArrowRight } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { useStorefront } from '../context/StorefrontContext';
import { FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';

export default function SearchAnalytics() {
	const { activeStore, analyticsData, hasStoreFeature } = useStorefront();
	const [activeTab, setActiveTab] = useState('ALL');

	if (!hasStoreFeature('search_forensics')) {
		return (
			<FeatureLockScreen
				featureName="Search Intent & Zero-Result Lab"
				creditCost={25}
				desc="Customer search query forensics, zero-result missed sale tracking, and catalog discovery demand."
			/>
		);
	}

	const zeroResultQueries = analyticsData.topSearches.filter((s) => !s.hasResults);
	const successfulQueries = analyticsData.topSearches.filter((s) => s.hasResults);

	const displayedQueries =
		activeTab === 'zero_results'
			? zeroResultQueries
			: activeTab === 'high_intent'
				? successfulQueries
				: analyticsData.topSearches;

	return (
		<div className="space-y-6 antialiased text-slate-900">
			<PageHeader
				title="Search Intent & Merchandising Forensics"
				subtitle={`Understand customer search terms and zero-result missed sales for ${activeStore?.name} (${activeStore?.domain})`}
			/>

			{/* KPI Cards */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard
					label="Total Storefront Searches"
					value={analyticsData.topSearches.reduce((sum, s) => sum + s.count, 0).toLocaleString()}
					change="Buyer intent queries"
				/>
				<StatCard
					label="Zero-Result Searches"
					value={zeroResultQueries.length.toString()}
					change="Unfulfilled customer demand"
				/>
				<StatCard label="Search-to-Cart Conversion" value="8.4%" change="Search vs browse" />
			</div>

			{/* Filter Tabs */}
			<div className="flex items-center gap-1.5 pb-2 border-b border-slate-200">
				<button
					type="button"
					onClick={() => setActiveTab('ALL')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
						activeTab === 'ALL'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
					}`}>
					All Search Queries ({analyticsData.topSearches.length})
				</button>
				<button
					type="button"
					onClick={() => setActiveTab('zero_results')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
						activeTab === 'zero_results'
							? 'bg-rose-600 text-white shadow-xs'
							: 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
					}`}>
					<AlertCircle size={13} />
					<span>Zero-Result Queries ({zeroResultQueries.length})</span>
				</button>
				<button
					type="button"
					onClick={() => setActiveTab('high_intent')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
						activeTab === 'high_intent'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100 text-slate-600 hover:text-slate-900 hover:bg-slate-200'
					}`}>
					Converted Searches ({successfulQueries.length})
				</button>
			</div>

			{/* Searches Table */}
			<Card title="Search Term Performance Matrix" subtitle="Frequency, result accuracy, and last search timestamps">
				{displayedQueries.length === 0 ? (
					<div className="py-8 text-center text-xs text-slate-400">
						No search queries recorded yet for {activeStore?.domain}.
					</div>
				) : (
					<div className="divide-y divide-slate-100 text-xs">
						{displayedQueries.map((item, idx) => (
							<div key={idx} className="py-3 flex items-center justify-between gap-3">
								<div className="flex items-center gap-3 min-w-0">
									<div className="p-2 rounded-xl bg-slate-100 text-slate-600">
										<Search size={15} />
									</div>
									<div className="min-w-0">
										<strong className="text-slate-900 text-sm block truncate">{item.query}</strong>
										<span className="text-[11px] text-slate-400">Last searched: {item.lastSearched}</span>
									</div>
								</div>

								<div className="flex items-center gap-4 shrink-0 text-right">
									<div>
										<span className="font-black text-sm text-slate-900">{item.count.toLocaleString()}</span>
										<span className="text-[10px] text-slate-400 block">searches</span>
									</div>
									<Badge type={item.hasResults ? 'success' : 'danger'}>
										{item.hasResults ? 'RESULTS FOUND' : '0 RESULTS (MISSED SALE)'}
									</Badge>
								</div>
							</div>
						))}
					</div>
				)}
			</Card>
		</div>
	);
}
