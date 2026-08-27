import React from 'react';
import { Link } from 'react-router-dom';
import { Plus, Users, Shield, Clock, ArrowRight } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { Card, StatCard } from '@saas/ui/cards/Card';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { usePortal } from '../../context/PortalContext';

export default function AdminDashboard() {
	const { tenants = [], products = [], depositRequests = [], auditLogs = [] } = usePortal();

	const safeTenants = tenants || [];
	const safeProducts = products || [];
	const safeDepositRequests = depositRequests || [];
	const safeAuditLogs = auditLogs || [];

	const activeTenants = safeTenants.filter((t) => t.status === 'active').length;
	const totalCirculatingCredits = safeTenants.reduce((sum, t) => sum + (t.creditsBalance || 0), 0);
	const pendingRequests = safeDepositRequests.filter((r) => r.status === 'pending');

	return (
		<div className="space-y-6 antialiased">
			<PageHeader
				title="Dashboard"
				subtitle="Overview of merchants, credit balances, and products"
				actions={
					<div className="flex items-center gap-2 px-3 py-1 rounded-xl bg-emerald-50 border border-emerald-200/80 text-xs font-semibold text-emerald-800">
						<span className="w-2 h-2 rounded-full bg-emerald-500" />
						<span>Platform Active</span>
					</div>
				}
			/>

			{/* KPI Grid */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard label="Total Merchants" value={activeTenants} change={`${safeTenants.length} registered`} />
				<StatCard
					label="Circulating Credits"
					value={`$${totalCirculatingCredits.toLocaleString()}.00`}
					change="Merchant wallet balances"
				/>
				<StatCard
					label="Pending Top-Ups"
					value={`${pendingRequests.length} Requests`}
					change={pendingRequests.length > 0 ? 'Action required' : 'All verified'}
				/>
				<StatCard label="Products" value={`${safeProducts.length} Registered`} change="Ready to license" />
			</div>

			{/* Pending Bank Top-Up Banner */}
			{pendingRequests.length > 0 && (
				<div className="p-4 rounded-2xl bg-indigo-50 border border-indigo-200 text-indigo-950 text-xs flex items-center justify-between shadow-xs">
					<div className="flex items-center gap-3">
						<div className="p-2 rounded-xl bg-indigo-600 text-white">
							<Clock size={16} />
						</div>
						<div>
							<div className="font-bold">
								{pendingRequests.length} Pending Bank Transfer Top-Up{' '}
								{pendingRequests.length === 1 ? 'Request' : 'Requests'}
							</div>
							<p className="text-indigo-800 text-[11px]">
								Merchants have submitted bank wire transfer proofs awaiting SuperAdmin verification.
							</p>
						</div>
					</div>
					<Link to="/billing">
						<Button size="sm">
							Review & Approve <ArrowRight size={12} />
						</Button>
					</Link>
				</div>
			)}

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Recent Merchants */}
				<div className="lg:col-span-2 space-y-4">
					<Card
						title="Recent Merchants"
						action={
							<Link to="/tenants">
								<Button size="sm">
									<Plus size={13} /> Add Merchant
								</Button>
							</Link>
						}>
						{safeTenants.length === 0 ? (
							<div className="py-12 px-4 text-center space-y-3">
								<div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto transition-transform duration-200 hover:scale-105">
									<Users size={22} />
								</div>
								<div className="space-y-1">
									<h4 className="font-bold text-sm text-slate-900">No Merchants Added Yet</h4>
									<p className="text-xs text-slate-500 max-w-sm mx-auto">
										Add your first merchant account to grant product licenses and manage credit balances.
									</p>
								</div>
								<div className="pt-2">
									<Link to="/tenants">
										<Button size="sm">Add Merchant</Button>
									</Link>
								</div>
							</div>
						) : (
							<DataTable
								columns={[
									{
										key: 'name',
										label: 'Merchant',
										render: (v, row) => (
											<div>
												<strong className="text-slate-900 text-xs font-semibold">{v}</strong>
												<div className="text-[11px] text-slate-400 font-mono">{row.domain}</div>
											</div>
										),
									},
									{
										key: 'creditsBalance',
										label: 'Credit Balance',
										render: (v) => (
											<span className="font-bold text-xs text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-lg border border-emerald-200">
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
										label: 'Products',
										render: (v) => (
											<span className="text-xs font-medium text-slate-600">
												{Array.isArray(v) ? v.length : 0} active
											</span>
										),
									},
								]}
								data={safeTenants.slice(0, 5)}
							/>
						)}
					</Card>
				</div>

				{/* Audit Trail */}
				<div className="space-y-4">
					<Card title="Recent Activity">
						{safeAuditLogs.length === 0 ? (
							<div className="py-8 text-center text-xs text-slate-400 space-y-1">
								<Shield size={18} className="mx-auto text-slate-300 mb-1" />
								<p>No activity logged yet.</p>
								<p className="text-[11px] text-slate-400">Actions taken on the platform will appear here.</p>
							</div>
						) : (
							<div className="space-y-2.5 font-mono text-xs">
								{safeAuditLogs.slice(0, 5).map((log) => (
									<div
										key={log.id}
										className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 hover:bg-slate-100/70 transition-colors duration-150 space-y-1">
										<div className="flex items-center justify-between text-[10px]">
											<span className="font-semibold text-slate-800">{log.actor}</span>
											<span className="text-slate-400">{log.timestamp}</span>
										</div>
										<div className="text-slate-700 font-sans text-xs">{log.action}</div>
										<div className="text-[10px] text-slate-400 truncate">{log.target}</div>
									</div>
								))}
							</div>
						)}
					</Card>
				</div>
			</div>
		</div>
	);
}
