import React, { useState } from 'react';
import { Plus, Search, RefreshCw, Trash2, Edit, Store } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { Modal } from '@saas/ui/modals/Modal';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { Select } from '@saas/ui/selects/Select';
import { Card } from '@saas/ui/cards/Card';
import { usePortal } from '../../context/PortalContext';

export default function TenantsManager() {
	const { tenants = [], addTenant, updateTenant, toggleTenantStatus, regenerateApiKey, deleteTenant } = usePortal();

	const safeTenants = tenants || [];
	const [search, setSearch] = useState('');
	const [selectedPlan, setSelectedPlan] = useState('ALL');
	const [selectedStatus, setSelectedStatus] = useState('ALL');

	const [isAddOpen, setIsAddOpen] = useState(false);
	const [editingTenant, setEditingTenant] = useState(null);

	const [newTenant, setNewTenant] = useState({
		name: '',
		domain: '',
		email: '',
		password: 'merchant123',
		plan: 'pro',
		initialCredits: '100',
	});

	const filteredTenants = safeTenants.filter((t) => {
		const matchesSearch =
			t.name.toLowerCase().includes(search.toLowerCase()) ||
			t.domain.toLowerCase().includes(search.toLowerCase()) ||
			t.email.toLowerCase().includes(search.toLowerCase());
		const matchesPlan = selectedPlan === 'ALL' || t.plan === selectedPlan;
		const matchesStatus = selectedStatus === 'ALL' || t.status === selectedStatus;
		return matchesSearch && matchesPlan && matchesStatus;
	});

	const handleCreate = (e) => {
		e.preventDefault();
		if (!newTenant.name.trim() || !newTenant.email.trim()) return;
		addTenant(newTenant);
		setIsAddOpen(false);
		setNewTenant({ name: '', domain: '', email: '', password: 'merchant123', plan: 'pro', initialCredits: '100' });
	};

	const handleSaveEdit = (e) => {
		e.preventDefault();
		if (!editingTenant) return;
		updateTenant(editingTenant.id, {
			...editingTenant,
			creditsBalance: Number(editingTenant.creditsBalance) || 0,
		});
		setEditingTenant(null);
	};

	return (
		<div className="space-y-6 antialiased">
			<PageHeader
				title="Merchant Management"
				subtitle={`${safeTenants.length} registered merchant accounts`}
				actions={
					<Button onClick={() => setIsAddOpen(true)}>
						<Plus size={15} /> Add Merchant
					</Button>
				}
			/>

			{safeTenants.length === 0 ? (
				<Card>
					<div className="py-16 px-4 text-center space-y-4">
						<div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto transition-transform duration-200 hover:scale-105">
							<Store size={28} />
						</div>
						<div className="space-y-1.5 max-w-md mx-auto">
							<h3 className="font-bold text-base text-slate-900">No Merchants Registered</h3>
							<p className="text-xs text-slate-500 leading-relaxed">
								Add a merchant to configure their store domain, credentials, credit wallet, and product subscriptions.
							</p>
						</div>
						<Button onClick={() => setIsAddOpen(true)}>
							<Plus size={14} /> Add First Merchant
						</Button>
					</div>
				</Card>
			) : (
				<>
					{/* Filter and Search Bar */}
					<div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
						<div className="relative flex-1 min-w-[280px]">
							<Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={15} />
							<Input
								className="pl-10"
								placeholder="Search by store name, domain, or email..."
								value={search}
								onChange={(e) => setSearch(e.target.value)}
							/>
						</div>

						<div className="flex items-center gap-3 flex-wrap">
							<div className="flex items-center gap-2">
								<Label className="mb-0 text-xs">Plan:</Label>
								<Select
									className="w-32 py-1.5 text-xs"
									value={selectedPlan}
									onChange={(e) => setSelectedPlan(e.target.value)}>
									<option value="ALL">All Plans</option>
									<option value="core">Core</option>
									<option value="pro">Pro</option>
									<option value="enterprise">Enterprise</option>
								</Select>
							</div>

							<div className="flex items-center gap-2">
								<Label className="mb-0 text-xs">Status:</Label>
								<Select
									className="w-32 py-1.5 text-xs"
									value={selectedStatus}
									onChange={(e) => setSelectedStatus(e.target.value)}>
									<option value="ALL">All Status</option>
									<option value="active">Active</option>
									<option value="suspended">Suspended</option>
								</Select>
							</div>
						</div>
					</div>

					{/* Tenants Table */}
					<DataTable
						columns={[
							{
								key: 'name',
								label: 'Storefront',
								render: (v, row) => (
									<div>
										<strong className="text-slate-900 text-xs font-semibold">{v}</strong>
										<div className="text-[11px] text-slate-400 font-mono">{row.domain}</div>
									</div>
								),
							},
							{
								key: 'email',
								label: 'Login Email',
								render: (v) => <span className="font-mono text-xs text-slate-600">{v}</span>,
							},
							{
								key: 'creditsBalance',
								label: 'Wallet Credits',
								render: (v) => (
									<span className="font-bold text-xs text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-xl border border-emerald-200">
										${v || 0}.00
									</span>
								),
							},
							{
								key: 'plan',
								label: 'Plan',
								render: (v) => (
									<Badge type={v === 'enterprise' ? 'pro' : v === 'pro' ? 'info' : 'neutral'}>
										{(v || 'pro').toUpperCase()}
									</Badge>
								),
							},
							{
								key: 'status',
								label: 'Status',
								render: (v) => <Badge type={v}>{String(v || 'active').toUpperCase()}</Badge>,
							},
							{
								key: 'products',
								label: 'Active Products',
								render: (v) => (
									<span className="font-semibold text-slate-700 text-xs">{Array.isArray(v) ? v.length : 0} apps</span>
								),
							},
							{
								key: 'actions',
								label: 'Actions',
								render: (_, row) => (
									<div className="flex items-center gap-1.5">
										<button
											type="button"
											onClick={() => setEditingTenant(row)}
											className="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-all duration-150 cursor-pointer active:scale-95"
											title="Edit Merchant Credentials">
											<Edit size={13} />
										</button>
										<button
											type="button"
											onClick={() => toggleTenantStatus(row.id)}
											className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all duration-150 cursor-pointer active:scale-95 ${
												row.status === 'active'
													? 'bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200'
													: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'
											}`}>
											{row.status === 'active' ? 'Suspend' : 'Activate'}
										</button>
										<button
											type="button"
											onClick={() => deleteTenant(row.id)}
											className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 transition-all duration-150 cursor-pointer active:scale-95"
											title="Delete Merchant">
											<Trash2 size={13} />
										</button>
									</div>
								),
							},
						]}
						data={filteredTenants}
					/>
				</>
			)}

			{/* Add Merchant Modal */}
			<Modal
				title="Add New Merchant Account"
				isOpen={isAddOpen}
				onClose={() => setIsAddOpen(false)}
				footer={
					<>
						<Button variant="secondary" onClick={() => setIsAddOpen(false)}>
							Cancel
						</Button>
						<Button onClick={handleCreate}>Save Merchant</Button>
					</>
				}>
				<form onSubmit={handleCreate} className="space-y-4">
					<div>
						<Label>Store Name</Label>
						<Input
							placeholder="e.g., Karachi Leather Co."
							required
							value={newTenant.name}
							onChange={(e) => setNewTenant({ ...newTenant, name: e.target.value })}
						/>
					</div>
					<div>
						<Label>Store Domain</Label>
						<Input
							placeholder="e.g., karachileather.com"
							value={newTenant.domain}
							onChange={(e) => setNewTenant({ ...newTenant, domain: e.target.value })}
						/>
					</div>
					<div>
						<Label>Merchant Login Email</Label>
						<Input
							type="email"
							placeholder="ops@karachileather.com"
							required
							value={newTenant.email}
							onChange={(e) => setNewTenant({ ...newTenant, email: e.target.value })}
						/>
					</div>
					<div>
						<Label>Login Password</Label>
						<Input
							type="text"
							placeholder="e.g., storePass123"
							required
							value={newTenant.password}
							onChange={(e) => setNewTenant({ ...newTenant, password: e.target.value })}
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div>
							<Label>Subscription Plan</Label>
							<Select value={newTenant.plan} onChange={(e) => setNewTenant({ ...newTenant, plan: e.target.value })}>
								<option value="core">Core Tier ($99/mo)</option>
								<option value="pro">Pro Tier ($450/mo)</option>
								<option value="enterprise">Enterprise Tier ($1,200/mo)</option>
							</Select>
						</div>
						<div>
							<Label>Initial Credits ($)</Label>
							<Input
								type="number"
								value={newTenant.initialCredits}
								onChange={(e) => setNewTenant({ ...newTenant, initialCredits: e.target.value })}
							/>
						</div>
					</div>
				</form>
			</Modal>

			{/* Edit Merchant Modal */}
			<Modal
				title={`Edit Merchant: ${editingTenant?.name || ''}`}
				isOpen={!!editingTenant}
				onClose={() => setEditingTenant(null)}
				footer={
					<>
						<Button variant="secondary" onClick={() => setEditingTenant(null)}>
							Cancel
						</Button>
						<Button onClick={handleSaveEdit}>Save Changes</Button>
					</>
				}>
				{editingTenant && (
					<div className="space-y-4 text-xs">
						<div>
							<Label>Store Name</Label>
							<Input
								value={editingTenant.name}
								onChange={(e) => setEditingTenant({ ...editingTenant, name: e.target.value })}
							/>
						</div>
						<div>
							<Label>Domain</Label>
							<Input
								value={editingTenant.domain}
								onChange={(e) => setEditingTenant({ ...editingTenant, domain: e.target.value })}
							/>
						</div>
						<div>
							<Label>Merchant Login Email</Label>
							<Input
								value={editingTenant.email}
								onChange={(e) => setEditingTenant({ ...editingTenant, email: e.target.value })}
							/>
						</div>
						<div>
							<Label>Reset Password</Label>
							<Input
								type="text"
								value={editingTenant.password || ''}
								placeholder="Enter new password"
								onChange={(e) => setEditingTenant({ ...editingTenant, password: e.target.value })}
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div>
								<Label>Subscription Plan</Label>
								<Select
									value={editingTenant.plan}
									onChange={(e) => setEditingTenant({ ...editingTenant, plan: e.target.value })}>
									<option value="core">Core ($99/mo)</option>
									<option value="pro">Pro ($450/mo)</option>
									<option value="enterprise">Enterprise ($1,200/mo)</option>
								</Select>
							</div>
							<div>
								<Label>Wallet Credits ($)</Label>
								<Input
									type="number"
									value={editingTenant.creditsBalance || 0}
									onChange={(e) => setEditingTenant({ ...editingTenant, creditsBalance: e.target.value })}
								/>
							</div>
						</div>
						<div className="pt-2 border-t border-slate-200 space-y-2">
							<div className="flex items-center justify-between">
								<Label className="mb-0">Publishable API Key</Label>
								<button
									type="button"
									onClick={() => regenerateApiKey(editingTenant.id, 'apiKey')}
									className="text-indigo-600 hover:text-indigo-800 text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors">
									<RefreshCw size={11} /> Regenerate
								</button>
							</div>
							<Input readOnly value={editingTenant.apiKey} className="font-mono text-slate-600 bg-slate-50" />
						</div>
					</div>
				)}
			</Modal>
		</div>
	);
}
