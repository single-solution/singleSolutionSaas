import React from 'react';
import { Filter, ArrowDownRight, Smartphone, Laptop, AlertCircle, TrendingUp, ShoppingBag, ArrowRight } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Badge } from '@saas/ui/badges/Badge';
import { useStorefront } from '../context/StorefrontContext';
import { FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';

export default function Funnel() {
	const { activeStore, analyticsData, hasStoreFeature } = useStorefront();

	if (!hasStoreFeature('funnel_dropoff')) {
		return (
			<FeatureLockScreen
				featureName="E-Commerce Funnel Forensics"
				creditCost={35}
				desc="5-stage conversion funnel, checkout drop-off diagnostics, and cart abandonment analytics."
			/>
		);
	}

	const funnel = analyticsData.funnel;
	const hasEvents = analyticsData.totalPageViews > 0;

	return (
		<div className="space-y-6 antialiased text-slate-900">
			<PageHeader
				title="Conversion Funnel Forensics"
				subtitle={
					activeStore
						? `Step-by-step buyer drop-off analysis and checkout leaks for ${activeStore.name} (${activeStore.domain})`
						: 'Step-by-step buyer drop-off analysis and checkout leaks'
				}
			/>

			{/* Top KPI Cards */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard
					label="Overall Store Conversion"
					value={`${funnel.overallConversionRate}%`}
					change={hasEvents ? 'Visitors to completed orders' : '0% (Awaiting traffic)'}
				/>
				<StatCard
					label="Total Orders Placed"
					value={funnel.stages[4].count.toLocaleString()}
					change="Confirmed transactions"
				/>
				<StatCard
					label="Gross Merchandise Value"
					value={`$${funnel.totalRevenue.toLocaleString()}`}
					change="Tracked revenue"
				/>
			</div>

			{/* Visual Multi-Step Funnel */}
			<Card title="5-Stage Buyer Conversion Journey">
				<div className="space-y-6 pt-2">
					<div className="space-y-4">
						{funnel.stages.map((stage, idx) => {
							const prevCount = idx > 0 ? funnel.stages[idx - 1].count : stage.count;
							const stepConversion = prevCount > 0 ? Math.round((stage.count / prevCount) * 100) : 0;
							const barWidth =
								funnel.stages[0].count > 0 ? Math.max(12, Math.round((stage.count / funnel.stages[0].count) * 100)) : 10;

							return (
								<div key={idx} className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-3">
									<div className="flex flex-wrap items-center justify-between gap-2 text-xs">
										<div className="flex items-center gap-2">
											<span className="w-6 h-6 rounded-lg bg-indigo-600 text-white font-bold flex items-center justify-center text-[11px]">
												0{idx + 1}
											</span>
											<div>
												<strong className="text-slate-900 text-sm font-bold">{stage.name}</strong>
												<span className="text-[11px] text-slate-500 block">{stage.description}</span>
											</div>
										</div>
										<div className="flex items-center gap-4 text-right">
											<div>
												<span className="text-base font-black text-slate-900">{stage.count.toLocaleString()}</span>
												<span className="text-[10px] text-slate-400 block">shoppers</span>
											</div>
											{idx > 0 && (
												<div className="text-xs">
													<span className="font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100">
														{stepConversion}% step retention
													</span>
													{stage.dropoffRate > 0 && (
														<span className="text-[11px] text-rose-600 font-semibold block mt-0.5">
															-{stage.dropoffRate}% drop-off
														</span>
													)}
												</div>
											)}
										</div>
									</div>

									{/* Progress Bar */}
									<div className="w-full h-3 bg-slate-200/70 rounded-full overflow-hidden">
										<div
											style={{ width: `${barWidth}%` }}
											className="h-full bg-indigo-600 rounded-full transition-all duration-500"
										/>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</Card>

			{/* Device Conversion Comparison & Drop-off Bottlenecks */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-6">
				{/* Device Comparison */}
				<Card title="Mobile vs Desktop Conversion Breakdown" subtitle="Compare shopping behavior across device viewports">
					<div className="space-y-4 pt-1 text-xs">
						<div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
							<div className="flex justify-between items-center">
								<span className="font-bold text-slate-900 flex items-center gap-2">
									<Smartphone size={16} className="text-indigo-600" />
									Mobile Storefront Shoppers
								</span>
								<span className="font-black text-sm text-indigo-700">
									{analyticsData.devices.find((d) => d.device.toLowerCase().includes('mobile'))?.percentage || 0}%
									traffic
								</span>
							</div>
							<p className="text-[11px] text-slate-500">
								Mobile buyers respond heavily to 1-click WhatsApp checkout and quick cart drawers.
							</p>
						</div>

						<div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
							<div className="flex justify-between items-center">
								<span className="font-bold text-slate-900 flex items-center gap-2">
									<Laptop size={16} className="text-slate-700" />
									Desktop Shoppers
								</span>
								<span className="font-black text-sm text-emerald-700">
									{analyticsData.devices.find((d) => d.device.toLowerCase().includes('desktop'))?.percentage || 0}%
									traffic
								</span>
							</div>
							<p className="text-[11px] text-slate-500">Higher average basket size with lower cart abandonment rates.</p>
						</div>
					</div>
				</Card>

				{/* Top Drop-Off Pages Before Checkout */}
				<Card
					title="Cart-to-Checkout Abandonment Bottlenecks"
					subtitle="Pages with the highest drop-off before order confirmation">
					<div className="divide-y divide-slate-100 text-xs">
						<div className="py-3 flex items-center justify-between">
							<div>
								<strong className="text-slate-900 block">/cart (Shopping Bag Drawer)</strong>
								<span className="text-[11px] text-slate-400">Cart stage drop-off</span>
							</div>
							<span className="font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-lg border border-rose-100">
								{funnel.stages[2].dropoffRate}% drop-off
							</span>
						</div>

						<div className="py-3 flex items-center justify-between">
							<div>
								<strong className="text-slate-900 block">/checkout (Shipping & Delivery Step)</strong>
								<span className="text-[11px] text-slate-400">Checkout stage drop-off</span>
							</div>
							<span className="font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-lg border border-rose-100">
								{funnel.stages[3].dropoffRate}% drop-off
							</span>
						</div>
					</div>
				</Card>
			</div>
		</div>
	);
}
