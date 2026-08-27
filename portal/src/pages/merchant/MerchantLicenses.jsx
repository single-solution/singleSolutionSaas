import React from 'react';
import { ExternalLink, CheckCircle2, XCircle, Grid, Coins, Sparkles } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Button } from '@saas/ui/buttons/Button';
import { Card } from '@saas/ui/cards/Card';
import { usePortal } from '../../context/PortalContext';
import { getAppLaunchUrl } from '@saas/ui/auth/ssoHandshake';
import { Link } from 'react-router-dom';

export default function MerchantLicenses() {
	const { activeTenant, products = [], toggleMerchantProductFeature, calculateMerchantMonthlyFee } = usePortal();

	if (!activeTenant) {
		return (
			<Card>
				<div className="py-16 text-center space-y-3">
					<div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
						<Grid size={24} />
					</div>
					<h3 className="font-bold text-sm text-slate-900">No Merchant Storefront Selected</h3>
					<p className="text-xs text-slate-500 max-w-sm mx-auto">
						Please sign in to a merchant storefront account to view and customize your active modular features.
					</p>
				</div>
			</Card>
		);
	}

	const safeProducts = products || [];
	const tenantSubscriptions = activeTenant.subscriptions || {};
	const monthlyCreditsCost = calculateMerchantMonthlyFee(activeTenant);
	const walletBalance = activeTenant.creditsBalance || 0;

	return (
		<div className="space-y-6 antialiased">
			<PageHeader
				title="Modular Products & Features"
				subtitle={`Enable or disable modular features for ${activeTenant.name} based on your business needs`}
				actions={
					<div className="flex items-center gap-3">
						<div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200 text-xs">
							<Coins size={14} className="text-amber-500" />
							<span className="text-slate-500">Wallet:</span>
							<strong className="text-slate-900">${walletBalance}.00 USD</strong>
						</div>
						<div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 font-semibold">
							<span>Active Cost:</span>
							<strong>${monthlyCreditsCost} credits / mo</strong>
						</div>
						<Link to="/merchant/billing">
							<Button size="sm">Top Up Credits</Button>
						</Link>
					</div>
				}
			/>

			{safeProducts.length === 0 ? (
				<Card>
					<div className="py-16 text-center space-y-2">
						<Grid size={24} className="mx-auto text-slate-300 mb-1" />
						<h4 className="font-bold text-sm text-slate-900">No Products Available</h4>
						<p className="text-xs text-slate-500">No products have been registered by platform administration yet.</p>
					</div>
				</Card>
			) : (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
					{safeProducts.map((product) => {
						const activeFeatureIds = tenantSubscriptions[product.id] || [];
						const features = Array.isArray(product.features) ? product.features : [];
						const launchUrl = getAppLaunchUrl(product.url || `http://localhost:${product.port}`, activeTenant, product);

						const activeFeaturesCount = features.filter((f) => activeFeatureIds.includes(f.id)).length;
						const productMonthlyCost = features
							.filter((f) => activeFeatureIds.includes(f.id))
							.reduce((sum, f) => sum + (Number(f.creditCost) || 0), 0);

						return (
							<div
								key={product.id}
								className="p-6 rounded-3xl bg-white border border-slate-200 shadow-xs flex flex-col justify-between space-y-5 transition-all duration-200 hover:shadow-md">
								<div className="space-y-4">
									{/* Header */}
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-3">
											<span className="text-3xl p-3 rounded-2xl bg-slate-50 border border-slate-200/80 transition-transform duration-150 hover:scale-105">
												{product.icon}
											</span>
											<div>
												<h3 className="font-extrabold text-slate-900 text-base">{product.name}</h3>
												<div className="flex items-center gap-2 mt-0.5">
													<span className="text-xs font-mono text-slate-500">{product.version || 'v1.0.0'}</span>
													<span className="text-[11px] text-slate-400">•</span>
													<span className="text-xs font-bold text-indigo-700">
														{activeFeaturesCount} of {features.length} modules active (${productMonthlyCost}/mo)
													</span>
												</div>
											</div>
										</div>

										<a
											href={launchUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-xs transition-all duration-150 flex items-center gap-1.5 shadow-xs hover:shadow-sm cursor-pointer active:scale-98"
											title={`Open ${product.name}`}>
											<span>Open Console</span>
											<ExternalLink size={12} />
										</a>
									</div>

									<p className="text-xs text-slate-600 leading-relaxed">{product.desc}</p>

									{/* Granular Feature Toggles */}
									<div className="space-y-2.5 pt-3 border-t border-slate-100">
										<div className="text-xs font-bold text-slate-900 uppercase tracking-wider">
											Modular Feature Subscriptions
										</div>

										<div className="space-y-2">
											{features.map((feature) => {
												const isEnabled = activeFeatureIds.includes(feature.id);

												return (
													<div
														key={feature.id}
														className={`p-3 rounded-2xl border transition-all flex items-center justify-between gap-3 text-xs ${
															isEnabled
																? 'bg-slate-50 border-slate-200/90'
																: 'bg-white border-slate-200/60 opacity-80'
														}`}>
														<div className="space-y-0.5 min-w-0">
															<div className="flex items-center gap-2">
																<strong className="text-slate-900 font-bold">{feature.name}</strong>
																<span className="font-semibold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100 text-[11px]">
																	${feature.creditCost} credits / mo
																</span>
															</div>
															<p className="text-[11px] text-slate-500 truncate">{feature.desc}</p>
														</div>

														<button
															type="button"
															onClick={() => toggleMerchantProductFeature(activeTenant.id, product.id, feature.id)}
															className={`px-3 py-1.5 rounded-xl font-bold text-xs transition-all duration-150 cursor-pointer flex items-center gap-1.5 shrink-0 active:scale-95 ${
																isEnabled
																	? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
																	: 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'
															}`}>
															{isEnabled ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
															<span>{isEnabled ? 'Active' : 'Disabled'}</span>
														</button>
													</div>
												);
											})}
										</div>
									</div>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
