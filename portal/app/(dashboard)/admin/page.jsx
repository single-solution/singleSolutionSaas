'use client';

import React from 'react';
import AdminMetrics from './_components/AdminMetrics';
import AppLaunchGrid from './_components/AppLaunchGrid';

export default function AdminPage() {
	return (
		<div className="space-y-8">
			{/* Top Hero Banner */}
			<div className="p-6 md:p-8 rounded-3xl bg-linear-to-r from-slate-900 via-indigo-950 to-slate-900 text-white shadow-xl space-y-3 relative overflow-hidden">
				<div className="relative z-10 max-w-2xl space-y-2">
					<div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md border border-white/10 text-[11px] font-bold text-indigo-300">
						<span>SingleSolution Multi-Tenant Cloud</span>
					</div>
					<h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">SuperAdmin Control Plane</h1>
					<p className="text-xs text-slate-300 leading-relaxed">
						Govern global store tenants, configure dynamic micro-app endpoints, verify wire transfer deposits, and monitor
						security telemetry across all connected instances.
					</p>
				</div>
			</div>

			{/* Core Metric Cards */}
			<AdminMetrics />

			{/* Micro-App Cluster Launchpads */}
			<AppLaunchGrid />
		</div>
	);
}
