import React from 'react';
import { ExternalLink, ArrowRight, Store } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { StatCard } from '@saas/ui/cards/StatCard';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { Card } from '@saas/ui/cards/Card';
import { usePortal } from '../../context/PortalContext';
import { getAppLaunchUrl } from '@saas/ui/auth/ssoHandshake';
import { Link } from 'react-router-dom';

export default function MerchantHome() {
	const { activeTenant, products = [], toggleTenantProduct } = usePortal();

	if (!activeTenant) {
		return (
			<Card>
				<div className="py-16 text-center space-y-3">
					<div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
						<Store size={24} />
					</div>
					<h3 className="font-bold text-sm text-slate-900">No Merchant Storefront Selected</h3>
					<p className="text-xs text-slate-500 max-w-sm mx-auto">
						There are currently no active merchant storefronts provisioned on the platform.
					</p>
				</div>
			</Card>
		);
	}

	const safeProducts = products || [];
	const safeTenantProducts = Array.isArray(activeTenant.products) ? activeTenant.products : [];
	const licensedApps = safeProducts.filter((p) => safeTenantProducts.includes(p.id));

	return (
		<div className="space-y-6 antialiased">
			<PageHeader
				title={`${activeTenant.name} Storefront Hub`}
				subtitle={`Connected domain: ${activeTenant.domain} • Subscription: ${activeTenant.plan?.toUpperCase()} Tier`}
				actions={
					<div className="flex items-center gap-2">
						<Badge type={activeTenant.status}>{String(activeTenant.status || 'active').toUpperCase()}</Badge>
						<Badge type="pro">{String(activeTenant.plan || 'pro').toUpperCase()} PLAN</Badge>
					</div>
				}
			/>

			{/* KPI Stats */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard
					label="Wallet Credit Balance"
					value={`$${activeTenant.creditsBalance || 0}.00 USD`}
					change="Prepaid Balance"
				/>
				<StatCard
					label="Active Products"
					value={`${licensedApps.length} of ${safeProducts.length}`}
					change="Enabled for Storefront"
				/>
				<StatCard label="Monthly Plan Fee" value={`$${activeTenant.mrr || 99}.00`} change="Billed Monthly" />
			</div>

			{/* Quick Launch Activated Apps */}
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-bold text-slate-900 tracking-tight">Your Licensed SaaS Applications</h3>
					<Link
						to="/merchant/licenses"
						className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 transition-colors">
						Manage Products <ArrowRight size={13} />
					</Link>
				</div>

				{safeProducts.length === 0 ? (
					<Card>
						<div className="py-12 text-center text-xs text-slate-400 space-y-1">
							<p className="font-semibold text-slate-700">No Products Available</p>
							<p>No SaaS products have been registered yet.</p>
						</div>
					</Card>
				) : (
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
						{safeProducts.map((product) => {
							const isLicensed = safeTenantProducts.includes(product.id);
							const launchUrl = getAppLaunchUrl(product.url || `http://localhost:${product.port}`, activeTenant, product);

							return (
								<div
									key={product.id}
									className={`p-6 rounded-2xl border flex flex-col justify-between space-y-5 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 ${
										isLicensed ? 'bg-white border-slate-200/90 shadow-xs' : 'bg-white/80 border-slate-200/60 opacity-80'
									}`}>
									<div className="space-y-3">
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-3">
												<span className="text-2xl p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 transition-transform duration-150 hover:scale-105">
													{product.icon}
												</span>
												<div>
													<h4 className="font-bold text-slate-900 text-sm leading-tight">{product.name}</h4>
													{product.version && (
														<span className="text-[11px] text-slate-500 font-mono">{product.version}</span>
													)}
												</div>
											</div>
											<Badge type={isLicensed ? 'active' : 'neutral'}>{isLicensed ? 'Active' : 'Unlicensed'}</Badge>
										</div>
										<p className="text-xs text-slate-600 leading-relaxed">{product.desc}</p>
									</div>

									<div className="flex items-center justify-between pt-3 border-t border-slate-100">
										<div className="text-xs">
											<span className="font-bold text-slate-900 text-sm">${product.price}</span>
											<span className="text-slate-500"> / mo</span>
										</div>
										{isLicensed ? (
											<a
												href={launchUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-xs transition-all duration-150 flex items-center gap-1.5 shadow-xs hover:shadow-sm cursor-pointer active:scale-98">
												<span>Open App</span>
												<ExternalLink size={12} />
											</a>
										) : (
											<Button
												size="sm"
												variant="secondary"
												onClick={() => toggleTenantProduct(activeTenant.id, product.id)}>
												Activate App
											</Button>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
