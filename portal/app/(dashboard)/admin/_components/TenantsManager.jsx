'use client';

import React, { useState } from 'react';
import { usePortal } from '../../../../context/PortalContext';
import {
	Plus,
	Sliders,
	Trash2,
	CheckCircle2,
	XCircle,
	Search,
	Edit3,
	RefreshCw,
	ExternalLink,
	Download,
	CreditCard,
	Globe,
	Layers,
	Coins,
} from 'lucide-react';

export default function TenantsManager() {
	const {
		tenants = [],
		products = [],
		addTenant,
		updateTenant,
		rotateTenantKeys,
		deleteTenant,
		toggleTenantStatus,
		addMerchantWebsite,
		deleteMerchantWebsite,
		toggleWebsiteFeature,
		grantAdminCredits,
		calculateMerchantMonthlyFee,
		calculateWebsiteMonthlyFee,
		launchMicroApp,
	} = usePortal();

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [editingTenant, setEditingTenant] = useState(null);
	const [licenseModalTenant, setLicenseModalTenant] = useState(null);
	const [selectedWebsiteId, setSelectedWebsiteId] = useState('');
	const [websiteModalTenant, setWebsiteModalTenant] = useState(null);
	const [creditModalTenant, setCreditModalTenant] = useState(null);
	const [searchTerm, setSearchTerm] = useState('');
	const [statusFilter, setStatusFilter] = useState('all');

	// Create Form State
	const [newName, setNewName] = useState('');
	const [newDomain, setNewDomain] = useState('');
	const [newEmail, setNewEmail] = useState('');
	const [newPassword, setNewPassword] = useState('');
	const [newPlan, setNewPlan] = useState('pro');
	const [newSecret, setNewSecret] = useState('');
	const [initialCredits, setInitialCredits] = useState('200');

	// Add Website Form State
	const [newSiteName, setNewSiteName] = useState('');
	const [newSiteDomain, setNewSiteDomain] = useState('');

	// Edit Form Extra State
	const [editPassword, setEditPassword] = useState('');

	// Credit Adjustment Modal State
	const [adjustAmount, setAdjustAmount] = useState('100');
	const [adjustReason, setAdjustReason] = useState('Customer Support Courtesy Credit');

	const handleCreateTenant = async (e) => {
		e.preventDefault();
		await addTenant({
			name: newName,
			domain: newDomain,
			email: newEmail,
			password: newPassword || undefined,
			plan: newPlan,
			secretKey: newSecret || undefined,
			initialCredits: Number(initialCredits),
		});
		setNewName('');
		setNewDomain('');
		setNewEmail('');
		setNewPassword('');
		setNewSecret('');
		setIsCreateOpen(false);
	};

	const handleUpdateTenant = async (e) => {
		e.preventDefault();
		if (!editingTenant) return;
		const updates = {
			name: editingTenant.name,
			domain: editingTenant.domain,
			email: editingTenant.email,
			contactEmail: editingTenant.contactEmail,
			plan: editingTenant.plan,
		};
		if (editPassword) {
			updates.password = editPassword;
		}
		await updateTenant(editingTenant.id, updates);
		setEditingTenant(null);
		setEditPassword('');
	};

	const handleAddWebsite = async (e) => {
		e.preventDefault();
		if (!websiteModalTenant) return;
		await addMerchantWebsite(websiteModalTenant.id, {
			name: newSiteName,
			domain: newSiteDomain,
		});
		setNewSiteName('');
		setNewSiteDomain('');
	};

	const handleGrantCredits = async (e) => {
		e.preventDefault();
		if (!creditModalTenant) return;
		await grantAdminCredits(creditModalTenant.id, Number(adjustAmount), adjustReason);
		setCreditModalTenant(null);
		setAdjustAmount('100');
	};

	const handleExportTenants = () => {
		const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(tenants, null, 2));
		const downloadAnchor = document.createElement('a');
		downloadAnchor.setAttribute('href', dataStr);
		downloadAnchor.setAttribute('download', `tenants_backup_${new Date().toISOString().slice(0, 10)}.json`);
		document.body.appendChild(downloadAnchor);
		downloadAnchor.click();
		downloadAnchor.remove();
	};

	const filteredTenants = tenants.filter((t) => {
		const matchesSearch =
			t.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
			t.domain?.toLowerCase().includes(searchTerm.toLowerCase()) ||
			t.id?.toLowerCase().includes(searchTerm.toLowerCase());
		const matchesStatus = statusFilter === 'all' || t.status === statusFilter;
		return matchesSearch && matchesStatus;
	});

	return (
		<div className="space-y-6">
			{/* Top Actions Bar */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
				<div>
					<h1 className="text-xl font-bold text-slate-900 tracking-tight">Merchant Stores & Multi-Website Hub</h1>
					<p className="text-xs text-slate-500">
						Provision merchants, attach multiple storefront domains, and assign apps with auto-calculated feature pricing
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2.5">
					<div className="relative">
						<Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
						<input
							type="text"
							placeholder="Search stores..."
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							className="pl-9 pr-3 py-1.5 rounded-xl bg-white border border-slate-200 text-xs text-slate-900 placeholder:text-slate-400 outline-none focus:border-indigo-500 w-44"
						/>
					</div>

					<select
						value={statusFilter}
						onChange={(e) => setStatusFilter(e.target.value)}
						className="py-1.5 px-3 rounded-xl bg-white border border-slate-200 text-xs text-slate-700 outline-none focus:border-indigo-500">
						<option value="all">All Statuses</option>
						<option value="active">Active Only</option>
						<option value="suspended">Suspended Only</option>
					</select>

					<button
						type="button"
						onClick={handleExportTenants}
						className="py-1.5 px-3 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
						title="Export Tenants as JSON">
						<Download size={13} />
						<span>Export</span>
					</button>

					<button
						type="button"
						onClick={() => setIsCreateOpen(true)}
						className="py-1.5 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs transition-all cursor-pointer">
						<Plus size={14} />
						<span>Provision Merchant</span>
					</button>
				</div>
			</div>

			{/* Stores Table */}
			<div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
				<div className="overflow-x-auto">
					<table className="w-full text-left text-xs">
						<thead>
							<tr className="border-b border-slate-100 bg-slate-50/50 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
								<th className="py-3.5 px-4">Merchant Identity</th>
								<th className="py-3.5 px-4">Connected Websites</th>
								<th className="py-3.5 px-4">Status</th>
								<th className="py-3.5 px-4">Wallet Balance</th>
								<th className="py-3.5 px-4">Monthly Commitment</th>
								<th className="py-3.5 px-4 text-right">Actions</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-100 font-medium text-slate-700">
							{filteredTenants.length > 0 ? (
								filteredTenants.map((t) => {
									const websites =
										Array.isArray(t.websites) && t.websites.length > 0
											? t.websites
											: [{ id: 'primary', name: t.name, domain: t.domain }];
									const monthlyFee = calculateMerchantMonthlyFee(t);

									return (
										<tr key={t.id} className="hover:bg-slate-50/60 transition-colors">
											<td className="py-3.5 px-4">
												<div className="flex items-center gap-3">
													<div className="w-8 h-8 rounded-xl bg-indigo-50 text-indigo-700 font-extrabold text-xs flex items-center justify-center">
														{t.name?.charAt(0) || 'M'}
													</div>
													<div>
														<div className="font-bold text-slate-900 flex items-center gap-1.5">
															<span>{t.name}</span>
															<span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-slate-100 text-slate-600 uppercase">
																{t.plan || 'pro'}
															</span>
														</div>
														<div className="text-[10px] text-slate-400 font-mono">
															{t.id} · {t.email}
														</div>
													</div>
												</div>
											</td>
											<td className="py-3.5 px-4">
												<div className="flex items-center gap-2">
													<button
														type="button"
														onClick={() => setWebsiteModalTenant(t)}
														className="px-2 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-800 font-bold text-xs flex items-center gap-1 transition-colors cursor-pointer"
														title="Manage attached storefronts">
														<Globe size={12} className="text-indigo-600" />
														<span>
															{websites.length} Storefront{websites.length === 1 ? '' : 's'}
														</span>
													</button>
													<span className="text-[11px] text-slate-400 font-mono hidden md:inline">
														{websites[0]?.domain}
													</span>
												</div>
											</td>
											<td className="py-3.5 px-4">
												<button
													type="button"
													onClick={() => toggleTenantStatus(t.id)}
													className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold cursor-pointer transition-all ${
														t.status === 'active'
															? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
															: 'bg-rose-50 text-rose-700 border border-rose-200'
													}`}>
													{t.status === 'active' ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
													<span>{t.status}</span>
												</button>
											</td>
											<td className="py-3.5 px-4">
												<div className="flex items-center gap-2">
													<div>
														<div className="font-extrabold text-slate-900">${t.creditsBalance || 0}</div>
														<div className="text-[10px] text-slate-400">Available Float</div>
													</div>
													<button
														type="button"
														onClick={() => setCreditModalTenant(t)}
														className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
														title="Adjust Credits">
														<CreditCard size={13} />
													</button>
												</div>
											</td>
											<td className="py-3.5 px-4">
												<div className="font-bold text-indigo-600 flex items-center gap-1">
													<Coins size={12} className="text-amber-500" />
													<span>${monthlyFee}</span>
													<span className="text-[10px] text-slate-400 font-normal">/mo</span>
												</div>
											</td>
											<td className="py-3.5 px-4 text-right space-x-1">
												<button
													type="button"
													onClick={() => {
														setLicenseModalTenant(t);
														setSelectedWebsiteId(websites[0]?.id || '');
													}}
													className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer"
													title="Manage Website Feature Licenses">
													<Sliders size={14} />
												</button>
												<button
													type="button"
													onClick={() => setWebsiteModalTenant(t)}
													className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer"
													title="Manage Attached Websites">
													<Globe size={14} />
												</button>
												<button
													type="button"
													onClick={() => {
														setEditingTenant(t);
														setEditPassword('');
													}}
													className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer"
													title="Edit Merchant Profile">
													<Edit3 size={14} />
												</button>
												<button
													type="button"
													onClick={() => {
														if (
															confirm(
																`Rotate API & Secret credentials for ${t.name}? Current keys will be invalidated.`,
															)
														) {
															rotateTenantKeys(t.id);
														}
													}}
													className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer"
													title="Rotate Secret & API Keys">
													<RefreshCw size={14} />
												</button>
												{products.length > 0 && (
													<button
														type="button"
														onClick={() => launchMicroApp(products[0], t)}
														className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors cursor-pointer"
														title={`Launch into ${products[0]?.name || 'App'} via SSO`}>
														<ExternalLink size={14} />
													</button>
												)}
												<button
													type="button"
													onClick={() => {
														if (confirm(`Delete merchant ${t.name}? This action is irreversible.`))
															deleteTenant(t.id);
													}}
													className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
													title="Delete Merchant">
													<Trash2 size={14} />
												</button>
											</td>
										</tr>
									);
								})
							) : (
								<tr>
									<td colSpan={6} className="py-12 text-center text-slate-400 text-xs">
										<p className="font-semibold text-slate-600 mb-1">No merchant stores provisioned yet</p>
										<p className="text-[11px] text-slate-400">
											Click &ldquo;Provision Merchant&rdquo; above to onboard your first client organization.
										</p>
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>

			{/* Manage Attached Websites Modal */}
			{websiteModalTenant && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-xl bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5 max-h-[85vh] overflow-y-auto">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<div className="flex items-center gap-2">
								<Globe size={18} className="text-indigo-600" />
								<h3 className="text-sm font-bold text-slate-900">
									Attached Storefront Websites · {websiteModalTenant.name}
								</h3>
							</div>
							<button onClick={() => setWebsiteModalTenant(null)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						{/* Attached Websites List */}
						<div className="space-y-2">
							<div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Active Websites</div>
							{(websiteModalTenant.websites || []).map((site) => {
								const siteCost = calculateWebsiteMonthlyFee(site);
								return (
									<div
										key={site.id}
										className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between gap-3 text-xs">
										<div>
											<div className="font-bold text-slate-900 flex items-center gap-1.5">
												<span>{site.name}</span>
												<span className="text-[10px] text-slate-400 font-mono">({site.domain})</span>
											</div>
											<div className="text-[10px] text-indigo-600 font-medium">
												${siteCost} credits/mo · {Object.keys(site.subscriptions || {}).length} Apps Active
											</div>
										</div>

										<div className="flex items-center gap-2">
											<button
												type="button"
												onClick={() => {
													setLicenseModalTenant(websiteModalTenant);
													setSelectedWebsiteId(site.id);
													setWebsiteModalTenant(null);
												}}
												className="px-2.5 py-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-xs cursor-pointer transition-colors">
												Licenses
											</button>
											{(websiteModalTenant.websites || []).length > 1 && (
												<button
													type="button"
													onClick={() => {
														if (confirm(`Remove website ${site.domain}?`)) {
															deleteMerchantWebsite(websiteModalTenant.id, site.id);
														}
													}}
													className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg cursor-pointer transition-colors">
													<Trash2 size={13} />
												</button>
											)}
										</div>
									</div>
								);
							})}
						</div>

						{/* Add New Website Form */}
						<form
							onSubmit={handleAddWebsite}
							className="p-4 rounded-xl bg-slate-100/70 border border-slate-200/80 space-y-3 text-xs">
							<div className="font-bold text-slate-900">Attach New Storefront Website</div>
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
								<div>
									<label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Website Name</label>
									<input
										type="text"
										required
										placeholder="e.g. Lahore Outlet"
										value={newSiteName}
										onChange={(e) => setNewSiteName(e.target.value)}
										className="w-full p-2 rounded-lg bg-white border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
									/>
								</div>
								<div>
									<label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Store Domain</label>
									<input
										type="text"
										required
										placeholder="outlet.yourbrand.com"
										value={newSiteDomain}
										onChange={(e) => setNewSiteDomain(e.target.value)}
										className="w-full p-2 rounded-lg bg-white border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
									/>
								</div>
							</div>
							<button
								type="submit"
								className="w-full py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-xs cursor-pointer transition-all">
								+ Attach Storefront Domain
							</button>
						</form>

						<div className="flex justify-end pt-2">
							<button
								type="button"
								onClick={() => setWebsiteModalTenant(null)}
								className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs">
								Done
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Per-Website Feature License Matrix Modal */}
			{licenseModalTenant && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-3xl bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5 max-h-[85vh] overflow-y-auto">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<div>
								<div className="flex items-center gap-2">
									<Sliders size={18} className="text-indigo-600" />
									<h3 className="text-base font-bold text-slate-900">
										Feature License Matrix · {licenseModalTenant.name}
									</h3>
								</div>
								<p className="text-xs text-slate-500">
									Select a storefront website below to assign micro-apps and granular feature licenses with
									auto-calculated pricing
								</p>
							</div>
							<button onClick={() => setLicenseModalTenant(null)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						{/* Website Selector Tabs */}
						<div className="space-y-2">
							<div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
								Select Storefront Website
							</div>
							<div className="flex flex-wrap gap-2">
								{(
									licenseModalTenant.websites || [
										{ id: 'primary', name: licenseModalTenant.name, domain: licenseModalTenant.domain },
									]
								).map((site) => {
									const isSelected = (selectedWebsiteId || licenseModalTenant.websites?.[0]?.id) === site.id;
									const siteCost = calculateWebsiteMonthlyFee(site);

									return (
										<button
											key={site.id}
											type="button"
											onClick={() => setSelectedWebsiteId(site.id)}
											className={`px-3.5 py-2 rounded-xl border text-xs text-left transition-all cursor-pointer ${
												isSelected
													? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
													: 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
											}`}>
											<div className="font-bold flex items-center gap-1.5">
												<Globe size={13} className={isSelected ? 'text-white' : 'text-indigo-600'} />
												<span>{site.name}</span>
											</div>
											<div className={`text-[10px] ${isSelected ? 'text-indigo-200' : 'text-slate-400'}`}>
												{site.domain} · ${siteCost}/mo
											</div>
										</button>
									);
								})}
							</div>
						</div>

						{/* App & Feature License Assignment for Selected Website */}
						{(() => {
							const currentSite = (licenseModalTenant.websites || []).find(
								(s) => s.id === (selectedWebsiteId || licenseModalTenant.websites?.[0]?.id),
							) ||
								licenseModalTenant.websites?.[0] || {
									id: 'primary',
									name: licenseModalTenant.name,
									domain: licenseModalTenant.domain,
									subscriptions: licenseModalTenant.subscriptions || {},
								};
							const siteCost = calculateWebsiteMonthlyFee(currentSite);

							return (
								<div className="space-y-4 pt-2 border-t border-slate-100">
									<div className="flex items-center justify-between p-3.5 rounded-xl bg-indigo-50 border border-indigo-100">
										<div>
											<span className="font-bold text-xs text-indigo-950">
												Active Website: {currentSite.name} ({currentSite.domain})
											</span>
											<span className="text-[11px] text-slate-500 block">
												Features toggled here apply strictly to this website.
											</span>
										</div>
										<div className="text-right">
											<span className="text-xs font-bold text-slate-400 uppercase">Website Float</span>
											<div className="text-lg font-black text-indigo-600">
												${siteCost} <span className="text-xs font-normal text-slate-500">/mo</span>
											</div>
										</div>
									</div>

									<div className="space-y-4">
										{products.map((prod) => {
											const activeFeatures = currentSite.subscriptions?.[prod.id] || [];
											const prodCost = (prod.features || []).reduce(
												(sum, f) => (activeFeatures.includes(f.id) ? sum + (f.creditCost || 0) : sum),
												0,
											);

											return (
												<div
													key={prod.id}
													className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-3">
													<div className="flex items-center justify-between">
														<div className="flex items-center gap-2">
															<span className="font-bold text-xs text-slate-900">{prod.name}</span>
														</div>
														<div className="text-xs font-bold text-indigo-600">${prodCost} credits/mo</div>
													</div>

													<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
														{prod.features?.map((feat) => {
															const isEnabled = activeFeatures.includes(feat.id);
															return (
																<button
																	key={feat.id}
																	type="button"
																	onClick={() =>
																		toggleWebsiteFeature(
																			licenseModalTenant.id,
																			currentSite.id,
																			prod.id,
																			feat.id,
																		)
																	}
																	className={`p-2.5 rounded-lg border text-left flex items-start justify-between gap-2 transition-all cursor-pointer ${
																		isEnabled
																			? 'bg-white border-indigo-300 text-indigo-900 shadow-2xs'
																			: 'bg-slate-100/60 border-slate-200/60 text-slate-400'
																	}`}>
																	<div>
																		<div className="text-[11px] font-bold">{feat.name}</div>
																		<div className="text-[10px] text-slate-500 font-semibold">
																			${feat.creditCost} credits/mo
																		</div>
																	</div>
																	<span
																		className={`px-1.5 py-0.5 rounded text-[9px] font-extrabold uppercase ${
																			isEnabled ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-500'
																		}`}>
																		{isEnabled ? 'On' : 'Off'}
																	</span>
																</button>
															);
														})}
													</div>
												</div>
											);
										})}
									</div>
								</div>
							);
						})()}

						<div className="flex justify-end pt-3 border-t border-slate-100">
							<button
								type="button"
								onClick={() => setLicenseModalTenant(null)}
								className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs">
								Done
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Edit Tenant Profile Modal */}
			{editingTenant && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<h3 className="text-sm font-bold text-slate-900">Edit Store Profile</h3>
							<button onClick={() => setEditingTenant(null)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						<form onSubmit={handleUpdateTenant} className="space-y-4 text-xs">
							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Store Name</label>
								<input
									type="text"
									required
									value={editingTenant.name}
									onChange={(e) => setEditingTenant({ ...editingTenant, name: e.target.value })}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Primary Domain</label>
								<input
									type="text"
									required
									value={editingTenant.domain}
									onChange={(e) => setEditingTenant({ ...editingTenant, domain: e.target.value })}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Admin Email</label>
								<input
									type="email"
									required
									value={editingTenant.email}
									onChange={(e) => setEditingTenant({ ...editingTenant, email: e.target.value })}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
									Reset Password (Leave blank to keep existing)
								</label>
								<input
									type="password"
									placeholder="New store password..."
									value={editPassword}
									onChange={(e) => setEditPassword(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Plan Tier</label>
								<select
									value={editingTenant.plan || 'pro'}
									onChange={(e) => setEditingTenant({ ...editingTenant, plan: e.target.value })}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500">
									<option value="starter">Starter Plan</option>
									<option value="pro">Pro Merchant Tier</option>
									<option value="enterprise">Enterprise Tier</option>
								</select>
							</div>

							<div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
								<button
									type="button"
									onClick={() => setEditingTenant(null)}
									className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold">
									Cancel
								</button>
								<button
									type="submit"
									className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-xs">
									Save Changes
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			{/* Grant Credits Modal */}
			{creditModalTenant && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<div>
								<h3 className="text-sm font-bold text-slate-900">Adjust Wallet Float</h3>
								<p className="text-[11px] text-slate-400">
									{creditModalTenant.name} (Current: ${creditModalTenant.creditsBalance || 0})
								</p>
							</div>
							<button onClick={() => setCreditModalTenant(null)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						<form onSubmit={handleGrantCredits} className="space-y-4 text-xs">
							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
									Credit Amount to Add / Subtract ($)
								</label>
								<input
									type="number"
									required
									value={adjustAmount}
									onChange={(e) => setAdjustAmount(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-bold outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
									Reason / Ledger Reference
								</label>
								<input
									type="text"
									required
									value={adjustReason}
									onChange={(e) => setAdjustReason(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
								<button
									type="button"
									onClick={() => setCreditModalTenant(null)}
									className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold">
									Cancel
								</button>
								<button
									type="submit"
									className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-xs">
									Apply Adjustment
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			{/* Create Tenant Modal */}
			{isCreateOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<h3 className="text-sm font-bold text-slate-900">Provision New Merchant Store</h3>
							<button onClick={() => setIsCreateOpen(false)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						<form onSubmit={handleCreateTenant} className="space-y-4 text-xs">
							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Merchant Store Name</label>
								<input
									type="text"
									required
									placeholder="e.g. Royal Gems Store"
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Primary Store Domain</label>
								<input
									type="text"
									required
									placeholder="royalgems.com"
									value={newDomain}
									onChange={(e) => setNewDomain(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Admin Email</label>
								<input
									type="email"
									required
									placeholder="owner@royalgems.com"
									value={newEmail}
									onChange={(e) => setNewEmail(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
									Store Password (For Merchant Login)
								</label>
								<input
									type="password"
									required
									placeholder="••••••••••••"
									value={newPassword}
									onChange={(e) => setNewPassword(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Initial Plan</label>
								<select
									value={newPlan}
									onChange={(e) => setNewPlan(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500">
									<option value="starter">Starter Tier</option>
									<option value="pro">Pro Merchant Tier</option>
									<option value="enterprise">Enterprise Tier</option>
								</select>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
									Initial Wallet Credits ($)
								</label>
								<input
									type="number"
									min="0"
									value={initialCredits}
									onChange={(e) => setInitialCredits(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
									Custom Secret Key (Optional)
								</label>
								<input
									type="text"
									placeholder="Auto-generated if left blank"
									value={newSecret}
									onChange={(e) => setNewSecret(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-[11px] outline-none focus:border-indigo-500"
								/>
							</div>

							<div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
								<button
									type="button"
									onClick={() => setIsCreateOpen(false)}
									className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold">
									Cancel
								</button>
								<button
									type="submit"
									className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-xs">
									Provision Store
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
