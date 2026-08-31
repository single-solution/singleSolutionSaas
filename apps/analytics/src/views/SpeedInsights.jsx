import React, { useState } from 'react';
import { Building2, ExternalLink } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card } from '@saas/ui/cards/Card';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { Modal } from '@saas/ui/modals/Modal';
import { useStorefront } from '../context/StorefrontContext';
import { FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';

export default function SpeedInsights() {
	const { activeStore, stores, analyticsData, hasStoreFeature, storeEvents, toggleFeature } = useStorefront();
	const [selectedMetric, setSelectedMetric] = useState(null);

	if (!activeStore || stores.length === 0) {
		return (
			<div className="space-y-6 antialiased text-slate-900 max-w-4xl">
				<PageHeader
					title="Core Web Vitals & Real-Device Speed"
					subtitle="Real-user performance forensics measured at the 75th percentile"
				/>
				<Card>
					<div className="py-16 px-4 text-center space-y-4 max-w-md mx-auto">
						<div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
							<Building2 size={28} />
						</div>
						<div className="space-y-1.5">
							<h3 className="font-extrabold text-base text-slate-900">No Merchant Storefront Available</h3>
							<p className="text-xs text-slate-500 leading-relaxed">
								Register a merchant store in the Master Portal to monitor real-device Core Web Vitals.
							</p>
						</div>
						<div className="pt-2">
							<a
								href="http://localhost:3000/admin/tenants"
								className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs transition-all shadow-xs">
								<span>Go to Master Portal</span>
								<ExternalLink size={13} />
							</a>
						</div>
					</div>
				</Card>
			</div>
		);
	}

	if (!hasStoreFeature('speed_insights')) {
		return (
			<FeatureLockScreen
				featureName="Speed & Core Web Vitals"
				creditCost={25}
				desc="Mobile P75 LCP, CLS, and INP performance monitoring across real buyer devices."
				onActivate={() => toggleFeature('speed_insights', 'enable')}
			/>
		);
	}

	const vitals = analyticsData.vitals;
	const webVitalEvents = storeEvents.filter((e) => e.eventType === 'web_vital');

	return (
		<div className="space-y-6 antialiased text-slate-900">
			<PageHeader
				title="Core Web Vitals & Real-Device Speed"
				subtitle={`Real-user performance forensics measured at the 75th percentile for ${activeStore.name} (${activeStore.domain})`}
			/>

			{/* Speed Score Overview Banner */}
			<div className="p-6 rounded-3xl bg-white border border-slate-200 shadow-xs flex flex-col md:flex-row items-center justify-between gap-6">
				<div className="flex items-center gap-5">
					<div className="w-16 h-16 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-black text-2xl border border-emerald-200 shadow-2xs">
						{analyticsData.speedScore}
					</div>
					<div className="space-y-1">
						<div className="flex items-center gap-2">
							<h3 className="font-extrabold text-slate-900 text-lg">Storefront Speed Health: Optimal</h3>
							<Badge type="success">PASSING CWV</Badge>
						</div>
						<p className="text-xs text-slate-500 max-w-md">
							Buyer sessions experience sub-second interactivity and instant media rendering.
						</p>
					</div>
				</div>

				<div className="flex items-center gap-4 text-xs">
					<div className="p-3 rounded-2xl bg-slate-50 border border-slate-200 text-center">
						<span className="text-slate-400 block text-[10px]">Vitals Samples</span>
						<strong className="text-slate-900 font-black text-sm">{webVitalEvents.length}</strong>
					</div>
				</div>
			</div>

			{/* 5 Core Web Vitals Metric Cards */}
			<div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
				{Object.entries(vitals).map(([key, metric]) => (
					<div
						key={key}
						onClick={() => setSelectedMetric(metric)}
						className="p-4 rounded-2xl bg-white border border-slate-200 shadow-xs space-y-3 cursor-pointer hover:border-indigo-400 transition-all hover:-translate-y-0.5">
						<div className="flex justify-between items-center text-xs">
							<span className="font-bold text-slate-900">{metric.metric}</span>
							<span className="text-[10px] font-semibold text-slate-400">{metric.threshold}</span>
						</div>

						<div className="space-y-0.5">
							<div className="text-xl font-black text-slate-900">
								{metric.p75}
								<span className="text-xs font-semibold text-slate-500 ml-0.5">{metric.unit}</span>
							</div>
							<div className="text-[11px] text-slate-500 truncate">{metric.name}</div>
						</div>

						<div className="space-y-1 pt-1">
							<div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden flex">
								<div style={{ width: `${metric.goodPercent}%` }} className="h-full bg-emerald-500" />
								<div style={{ width: `${metric.needsImprovementPercent}%` }} className="h-full bg-amber-400" />
								<div style={{ width: `${metric.poorPercent}%` }} className="h-full bg-rose-500" />
							</div>
							<div className="flex justify-between text-[10px] text-slate-500">
								<span className="text-emerald-600 font-bold">{metric.goodPercent}% Good</span>
								<span className="text-slate-400">{metric.poorPercent}% Poor</span>
							</div>
						</div>
					</div>
				))}
			</div>

			{/* Metric Detail Modal */}
			<Modal
				title={`Diagnostic Detail: ${selectedMetric?.name || ''}`}
				isOpen={!!selectedMetric}
				onClose={() => setSelectedMetric(null)}
				footer={<Button onClick={() => setSelectedMetric(null)}>Close</Button>}>
				{selectedMetric && (
					<div className="space-y-4 text-xs">
						<div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
							<div className="flex justify-between items-center">
								<span className="font-bold text-sm text-slate-900">{selectedMetric.name}</span>
								<span className="font-black text-lg text-emerald-700">
									{selectedMetric.p75} {selectedMetric.unit}
								</span>
							</div>
							<p className="text-slate-600 leading-relaxed">{selectedMetric.desc}</p>
						</div>

						<div className="p-4 rounded-2xl bg-indigo-50 border border-indigo-100 text-indigo-950 space-y-1">
							<div className="font-bold">Optimization Action:</div>
							<p className="leading-relaxed text-[11px] text-indigo-900">{selectedMetric.recommendation}</p>
						</div>
					</div>
				)}
			</Modal>
		</div>
	);
}
