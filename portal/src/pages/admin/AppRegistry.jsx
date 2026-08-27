import React, { useState } from 'react';
import { ExternalLink, Plus, Trash2, Globe, Grid, Sparkles, CheckCircle2, XCircle, DollarSign, Settings } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { Label } from '@saas/ui/inputs/Label';
import { Input } from '@saas/ui/inputs/TextInput';
import { Modal } from '@saas/ui/modals/Modal';
import { Card } from '@saas/ui/cards/Card';
import { usePortal, SUITE_PRESET_PRODUCTS } from '../../context/PortalContext';
import { getAppLaunchUrl } from '@saas/ui/auth/ssoHandshake';

export default function AppRegistry() {
	const {
		products = [],
		tenants = [],
		currentUser,
		toggleMerchantProductFeature,
		updateProductFeatureCost,
		addProductFeature,
		registerProduct,
		deleteProduct,
	} = usePortal();

	const [selectedMerchantId, setSelectedMerchantId] = useState(tenants[0]?.id || '');
	const [isRegisterOpen, setIsRegisterOpen] = useState(false);
	const [editingFeature, setEditingFeature] = useState(null); // { productId, feature }
	const [featurePriceInput, setFeaturePriceInput] = useState('30');
	const [newFeatureModal, setNewFeatureModal] = useState(null); // productId
	const [newFeatureForm, setNewFeatureForm] = useState({ id: '', name: '', creditCost: '30', desc: '' });

	const [newApp, setNewApp] = useState({
		name: '',
		url: '',
		icon: '⚡',
		desc: '',
		features: [
			{ id: 'core', name: 'Core Engine Module', creditCost: 35, desc: 'Base capabilities' },
			{ id: 'pro_analytics', name: 'Advanced Forensics & Telemetry', creditCost: 25, desc: 'Real-time reporting' },
		],
	});

	const targetTenant = tenants.find((t) => t.id === selectedMerchantId) || tenants[0] || currentUser || null;

	const handleRegisterApp = (e) => {
		e.preventDefault();
		if (!newApp.name.trim() || !newApp.url.trim()) return;

		registerProduct({
			name: newApp.name,
			url: newApp.url,
			icon: newApp.icon || '🚀',
			desc: newApp.desc || 'Custom imported SaaS micro-application.',
			features: newApp.features,
		});

		setIsRegisterOpen(false);
		setNewApp({
			name: '',
			url: '',
			icon: '⚡',
			desc: '',
			features: [
				{ id: 'core', name: 'Core Engine Module', creditCost: 35, desc: 'Base capabilities' },
				{ id: 'pro_analytics', name: 'Advanced Forensics & Telemetry', creditCost: 25, desc: 'Real-time reporting' },
			],
		});
	};

	const handleLoadPresets = () => {
		SUITE_PRESET_PRODUCTS.forEach((preset) => registerProduct(preset));
	};

	const handleSaveFeaturePrice = (e) => {
		e.preventDefault();
		if (!editingFeature) return;
		updateProductFeatureCost(editingFeature.productId, editingFeature.feature.id, Number(featurePriceInput));
		setEditingFeature(null);
	};

	const handleAddFeatureSubmit = (e) => {
		e.preventDefault();
		if (!newFeatureModal || !newFeatureForm.name.trim() || !newFeatureForm.id.trim()) return;
		addProductFeature(newFeatureModal, {
			id: newFeatureForm.id.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
			name: newFeatureForm.name.trim(),
			creditCost: Number(newFeatureForm.creditCost) || 25,
			desc: newFeatureForm.desc.trim() || 'Custom feature module',
		});
		setNewFeatureModal(null);
		setNewFeatureForm({ id: '', name: '', creditCost: '30', desc: '' });
	};

	return (
		<div className="space-y-6 antialiased">
			<PageHeader
				title="Product & Feature Governance"
				subtitle={`${products.length} registered products • Granular feature credit pricing`}
				actions={
					<div className="flex items-center gap-2">
						{products.length === 0 && (
							<Button variant="secondary" onClick={handleLoadPresets}>
								<Sparkles size={14} /> Load Platform Suite (5 Apps)
							</Button>
						)}
						<Button onClick={() => setIsRegisterOpen(true)}>
							<Plus size={14} /> Import Custom App
						</Button>
					</div>
				}
			/>

			{products.length === 0 ? (
				<Card>
					<div className="py-16 px-4 text-center space-y-4">
						<div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto transition-transform duration-200 hover:scale-105">
							<Grid size={28} />
						</div>
						<div className="space-y-1.5 max-w-md mx-auto">
							<h3 className="font-bold text-base text-slate-900">No Products Registered Yet</h3>
							<p className="text-xs text-slate-500 leading-relaxed">
								Import any micro-app running on any URL or port, or load the built-in platform suite apps.
							</p>
						</div>
						<div className="flex items-center justify-center gap-3 pt-2">
							<Button onClick={() => setIsRegisterOpen(true)}>
								<Plus size={14} /> Import Custom App
							</Button>
							<Button variant="secondary" onClick={handleLoadPresets}>
								<Sparkles size={14} /> Load Platform Suite (5 Apps)
							</Button>
						</div>
					</div>
				</Card>
			) : (
				<>
					{/* Target Merchant Selector Bar */}
					{tenants.length > 0 && (
						<div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
							<div className="flex items-center gap-3">
								<Label className="mb-0 text-xs text-slate-500">Configure Merchant Feature Access:</Label>
								<select
									className="px-3.5 py-1.5 rounded-xl bg-white border border-slate-300 text-xs text-slate-900 font-medium focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 shadow-2xs transition-all duration-150"
									value={selectedMerchantId}
									onChange={(e) => setSelectedMerchantId(e.target.value)}>
									{tenants.map((t) => (
										<option key={t.id} value={t.id}>
											{t.name} (Wallet: ${t.creditsBalance || 0} • {Object.values(t.subscriptions || {}).flat().length}{' '}
											features active)
										</option>
									))}
								</select>
							</div>
							{targetTenant && (
								<div className="text-xs text-slate-500 font-medium">
									Active Subscription Cost for {targetTenant.name}:{' '}
									<strong className="text-slate-900">${targetTenant.mrr || 0} credits / mo</strong>
								</div>
							)}
						</div>
					)}

					{/* Product & Granular Features List */}
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
						{products.map((product) => {
							const merchantSubscribedFeatures =
								(targetTenant?.subscriptions && targetTenant.subscriptions[product.id]) || [];
							const features = Array.isArray(product.features) ? product.features : [];
							const totalProductCredits = features.reduce((sum, f) => sum + (Number(f.creditCost) || 0), 0);
							const launchUrl = getAppLaunchUrl(product.url || `http://localhost:${product.port}`, targetTenant, product);

							return (
								<div
									key={product.id}
									className="p-6 rounded-3xl bg-white border border-slate-200 shadow-xs flex flex-col justify-between space-y-5 transition-all duration-200 hover:shadow-md">
									<div className="space-y-4">
										{/* Product Header */}
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-3">
												<span className="text-3xl p-3 rounded-2xl bg-slate-50 border border-slate-200/80 transition-transform duration-150 hover:scale-105">
													{product.icon}
												</span>
												<div>
													<div className="flex items-center gap-2">
														<h3 className="font-extrabold text-slate-900 text-base">{product.name}</h3>
														<button
															type="button"
															onClick={() => deleteProduct(product.id)}
															title="Delete App"
															className="text-slate-400 hover:text-rose-600 p-0.5 cursor-pointer transition-colors">
															<Trash2 size={13} />
														</button>
													</div>
													<div className="flex items-center gap-2 mt-0.5">
														<span className="text-xs font-mono text-slate-500">{product.version || 'v1.0.0'}</span>
														<span className="text-[11px] text-slate-400">•</span>
														<span className="text-xs font-bold text-indigo-700">
															${totalProductCredits} credits / mo full suite
														</span>
													</div>
												</div>
											</div>

											<a
												href={launchUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-xs transition-all duration-150 flex items-center gap-1.5 shadow-xs cursor-pointer active:scale-98"
												title={`Launch ${product.name}`}>
												<span>Open</span>
												<ExternalLink size={12} />
											</a>
										</div>

										<p className="text-xs text-slate-600 leading-relaxed">{product.desc}</p>

										{/* Granular Features & Credit Costs Breakdown */}
										<div className="space-y-2.5 pt-3 border-t border-slate-100">
											<div className="flex items-center justify-between">
												<span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
													Modular Features & Credit Pricing
												</span>
												<button
													type="button"
													onClick={() => setNewFeatureModal(product.id)}
													className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold flex items-center gap-1 cursor-pointer transition-colors">
													<Plus size={12} /> Add Feature
												</button>
											</div>

											<div className="space-y-2">
												{features.map((feature) => {
													const isFeatureActive = merchantSubscribedFeatures.includes(feature.id);

													return (
														<div
															key={feature.id}
															className="p-3 rounded-2xl bg-slate-50 border border-slate-200/80 flex items-center justify-between gap-3 text-xs transition-all hover:bg-slate-100/70">
															<div className="space-y-0.5 min-w-0">
																<div className="flex items-center gap-2">
																	<strong className="text-slate-900 font-bold">{feature.name}</strong>
																	<span className="font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100 text-[11px]">
																		${feature.creditCost} credits / mo
																	</span>
																</div>
																<p className="text-[11px] text-slate-500 truncate">{feature.desc}</p>
															</div>

															<div className="flex items-center gap-2 shrink-0">
																<button
																	type="button"
																	onClick={() => {
																		setEditingFeature({ productId: product.id, feature });
																		setFeaturePriceInput(String(feature.creditCost));
																	}}
																	className="p-1.5 rounded-lg bg-white hover:bg-slate-200 text-slate-600 border border-slate-200 cursor-pointer transition-colors"
																	title="Edit Credit Pricing">
																	<DollarSign size={12} />
																</button>

																{targetTenant && targetTenant.role !== 'admin' && (
																	<button
																		type="button"
																		onClick={() =>
																			toggleMerchantProductFeature(targetTenant.id, product.id, feature.id)
																		}
																		className={`px-2.5 py-1 rounded-xl text-xs font-bold transition-all duration-150 cursor-pointer flex items-center gap-1 active:scale-95 ${
																			isFeatureActive
																				? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
																				: 'bg-slate-200 hover:bg-slate-300 text-slate-700'
																		}`}>
																		{isFeatureActive ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
																		<span>{isFeatureActive ? 'Active' : 'Disabled'}</span>
																	</button>
																)}
															</div>
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
				</>
			)}

			{/* Edit Feature Credit Cost Modal */}
			<Modal
				title={`Edit Feature Credit Pricing: ${editingFeature?.feature?.name || ''}`}
				isOpen={!!editingFeature}
				onClose={() => setEditingFeature(null)}
				footer={
					<>
						<Button variant="secondary" onClick={() => setEditingFeature(null)}>
							Cancel
						</Button>
						<Button onClick={handleSaveFeaturePrice}>Save Pricing</Button>
					</>
				}>
				<form onSubmit={handleSaveFeaturePrice} className="space-y-4 text-xs">
					<div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
						<span className="text-slate-500">Feature:</span>
						<div className="font-bold text-sm text-slate-900">{editingFeature?.feature?.name}</div>
						<div className="text-[11px] text-slate-500">{editingFeature?.feature?.desc}</div>
					</div>

					<div>
						<Label>Monthly Credit Cost ($)</Label>
						<Input
							type="number"
							required
							min="0"
							value={featurePriceInput}
							onChange={(e) => setFeaturePriceInput(e.target.value)}
						/>
						<p className="text-[11px] text-slate-400 mt-1">
							When merchants enable this feature, this amount is charged against their credit balance each month.
						</p>
					</div>
				</form>
			</Modal>

			{/* Add Feature Modal */}
			<Modal
				title="Add New Feature Module"
				isOpen={!!newFeatureModal}
				onClose={() => setNewFeatureModal(null)}
				footer={
					<>
						<Button variant="secondary" onClick={() => setNewFeatureModal(null)}>
							Cancel
						</Button>
						<Button onClick={handleAddFeatureSubmit}>Add Feature</Button>
					</>
				}>
				<form onSubmit={handleAddFeatureSubmit} className="space-y-4 text-xs">
					<div>
						<Label>Feature Name</Label>
						<Input
							placeholder="e.g., WhatsApp Order Escalation"
							required
							value={newFeatureForm.name}
							onChange={(e) => setNewFeatureForm({ ...newFeatureForm, name: e.target.value })}
						/>
					</div>

					<div>
						<Label>Feature ID Key (Slug)</Label>
						<Input
							placeholder="e.g., whatsapp_escalation"
							required
							value={newFeatureForm.id}
							onChange={(e) => setNewFeatureForm({ ...newFeatureForm, id: e.target.value })}
						/>
					</div>

					<div>
						<Label>Monthly Credit Cost ($)</Label>
						<Input
							type="number"
							required
							value={newFeatureForm.creditCost}
							onChange={(e) => setNewFeatureForm({ ...newFeatureForm, creditCost: e.target.value })}
						/>
					</div>

					<div>
						<Label>Description</Label>
						<Input
							placeholder="What this module unlocks..."
							value={newFeatureForm.desc}
							onChange={(e) => setNewFeatureForm({ ...newFeatureForm, desc: e.target.value })}
						/>
					</div>
				</form>
			</Modal>

			{/* Import Custom App Modal */}
			<Modal
				title="Import Custom SaaS Application"
				isOpen={isRegisterOpen}
				onClose={() => setIsRegisterOpen(false)}
				footer={
					<>
						<Button variant="secondary" onClick={() => setIsRegisterOpen(false)}>
							Cancel
						</Button>
						<Button onClick={handleRegisterApp}>Import & Register</Button>
					</>
				}>
				<form onSubmit={handleRegisterApp} className="space-y-4 text-xs">
					<div>
						<Label>Application Name</Label>
						<Input
							placeholder="e.g., Inventory Sync Engine"
							required
							value={newApp.name}
							onChange={(e) => setNewApp({ ...newApp, name: e.target.value })}
						/>
					</div>

					<div>
						<Label>Application Target URL / Endpoint</Label>
						<div className="relative">
							<Globe size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
							<Input
								className="pl-9 font-mono"
								placeholder="https://app.custom-domain.com or http://localhost:5006"
								required
								value={newApp.url}
								onChange={(e) => setNewApp({ ...newApp, url: e.target.value })}
							/>
						</div>
					</div>

					<div>
						<Label>Icon Emoji</Label>
						<Input
							placeholder="e.g., 📦, ⚡, 🚀"
							value={newApp.icon}
							onChange={(e) => setNewApp({ ...newApp, icon: e.target.value })}
						/>
					</div>

					<div>
						<Label>Short Description</Label>
						<Input
							placeholder="Describe what this micro-app does..."
							value={newApp.desc}
							onChange={(e) => setNewApp({ ...newApp, desc: e.target.value })}
						/>
					</div>
				</form>
			</Modal>
		</div>
	);
}
