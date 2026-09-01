'use client';

import React from 'react';
import Link from 'next/link';
import { usePortal } from '../../../../context/PortalContext';
import { ExternalLink, Zap, Shield, Plus } from 'lucide-react';

export default function AppLaunchGrid() {
	const { products = [], launchMicroApp } = usePortal();

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-base font-bold text-slate-900">SaaS Micro-Application Cluster</h2>
					<p className="text-xs text-slate-500">Live SSO handshake launchpads with tenant credential encapsulation</p>
				</div>
			</div>

			{products.length > 0 ? (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{products.map((product) => (
						<div
							key={product.id}
							className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between space-y-4 transition-all hover:shadow-md hover:border-slate-300 group">
							<div className="space-y-3">
								<div className="flex items-center justify-between">
									<div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-base shadow-2xs group-hover:scale-105 transition-transform">
										<Zap size={20} />
									</div>
									<div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold">
										<span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
										<span>{product.status || 'operational'}</span>
									</div>
								</div>

								<div>
									<h3 className="text-sm font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">
										{product.name}
									</h3>
									<p className="text-[11px] text-slate-500 line-clamp-2 mt-1 leading-relaxed">
										{product.desc || product.description}
									</p>
								</div>
							</div>

							<button
								type="button"
								onClick={() => launchMicroApp(product)}
								className="w-full py-2 px-3 rounded-xl bg-slate-900 hover:bg-indigo-600 text-white text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-2xs hover:shadow-md active:scale-98">
								<Shield size={13} />
								<span>Launch Master SSO</span>
								<ExternalLink size={13} />
							</button>
						</div>
					))}
				</div>
			) : (
				<div className="p-8 rounded-2xl bg-white border border-slate-200/80 shadow-xs text-center space-y-3">
					<div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
						<Zap size={22} />
					</div>
					<div>
						<h3 className="text-sm font-bold text-slate-900">No Micro-Applications Registered</h3>
						<p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
							Register your micro-apps in the App Registry to enable SSO access and feature license provisioning.
						</p>
					</div>
					<Link
						href="/admin/registry"
						className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-xs transition-all">
						<Plus size={14} />
						<span>Register Your First Micro-App</span>
					</Link>
				</div>
			)}
		</div>
	);
}
