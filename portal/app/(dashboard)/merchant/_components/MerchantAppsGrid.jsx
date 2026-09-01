'use client';

import React from 'react';
import { usePortal } from '../../../../context/PortalContext';
import { ExternalLink, Layers } from 'lucide-react';

export default function MerchantAppsGrid() {
	const { products = [], activeTenant, launchMicroApp } = usePortal();

	return (
		<div className="space-y-6">
			{/* Welcome Banner */}
			<div className="p-6 md:p-8 rounded-3xl bg-linear-to-r from-slate-900 via-indigo-950 to-slate-900 text-white shadow-xl space-y-3 relative overflow-hidden">
				<div className="relative z-10 max-w-2xl space-y-2">
					<div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 backdrop-blur-md border border-white/10 text-[11px] font-bold text-indigo-300">
						<span>Store: {activeTenant?.name || 'Your Store'}</span>
					</div>
					<h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">E-Commerce Application Console</h1>
					<p className="text-xs text-slate-300 leading-relaxed">
						Access all licensed micro-applications directly with single sign-on authentication. Features and tier
						permissions are seamlessly synchronized via signed SSO tokens.
					</p>
				</div>
			</div>

			{/* Micro-App Cards */}
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<h2 className="text-base font-bold text-slate-900">Your Connected Micro-Apps</h2>
					{activeTenant?.domain && (
						<span className="text-xs text-slate-500">
							Store Domain: <strong className="text-indigo-600 font-mono">{activeTenant.domain}</strong>
						</span>
					)}
				</div>

				{products.length > 0 ? (
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
						{products.map((product) => {
							const activeFeatures = activeTenant?.subscriptions?.[product.id] || [];
							const isSubscribed = activeFeatures.length > 0;

							return (
								<div
									key={product.id}
									className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between space-y-4 transition-all hover:shadow-md hover:border-slate-300 group">
									<div className="space-y-3">
										<div className="flex items-center justify-between">
											<div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-base shadow-2xs group-hover:scale-105 transition-transform">
												<Layers size={20} />
											</div>
											<span
												className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${
													isSubscribed
														? 'bg-emerald-50 text-emerald-700 border-emerald-200'
														: 'bg-slate-100 text-slate-500 border-slate-200'
												}`}>
												{isSubscribed ? `${activeFeatures.length} Active Modules` : 'Unlicensed'}
											</span>
										</div>

										<div>
											<h3 className="text-sm font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">
												{product.name}
											</h3>
											<p className="text-[11px] text-slate-500 line-clamp-2 mt-1 leading-relaxed">
												{product.desc || product.description}
											</p>
										</div>

										{/* Active Feature Chips */}
										{product.features && product.features.length > 0 && (
											<div className="space-y-1.5 pt-1">
												<div className="text-[10px] font-bold text-slate-400 uppercase">Licensed Features:</div>
												<div className="flex flex-wrap gap-1">
													{product.features.map((f) => {
														const isEnabled = activeFeatures.includes(f.id);
														return (
															<span
																key={f.id}
																className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
																	isEnabled
																		? 'bg-indigo-50 text-indigo-800 border border-indigo-100'
																		: 'bg-slate-100 text-slate-400 opacity-60'
																}`}>
																{f.name}
															</span>
														);
													})}
												</div>
											</div>
										)}
									</div>

									<button
										type="button"
										onClick={() => launchMicroApp(product, activeTenant)}
										className="w-full py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xs hover:shadow-md active:scale-98">
										<span>Open Application</span>
										<ExternalLink size={13} />
									</button>
								</div>
							);
						})}
					</div>
				) : (
					<div className="p-8 rounded-2xl bg-white border border-slate-200/80 shadow-xs text-center text-xs text-slate-400">
						No SaaS applications configured on the platform yet.
					</div>
				)}
			</div>
		</div>
	);
}
