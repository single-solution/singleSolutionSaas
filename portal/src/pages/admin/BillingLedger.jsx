import React, { useState } from 'react';
import { CheckCircle2, XCircle, Plus, Coins, Clock, Building2, Download, Search } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { StatCard } from '@saas/ui/cards/StatCard';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { Modal } from '@saas/ui/modals/Modal';
import { Card } from '@saas/ui/cards/Card';
import { Label } from '@saas/ui/inputs/Label';
import { Input } from '@saas/ui/inputs/TextInput';
import { Select } from '@saas/ui/selects/Select';
import { usePortal } from '../../context/PortalContext';

export default function BillingLedger() {
	const {
		tenants,
		depositRequests,
		creditTransactions,
		platformBankDetails,
		approveDepositRequest,
		rejectDepositRequest,
		adjustMerchantCredits,
		updateBankDetails,
		showToast,
	} = usePortal();

	const [activeTab, setActiveTab] = useState('requests'); // 'requests' | 'wallets' | 'ledger' | 'bank_settings'
	const [selectedTenantForCredit, setSelectedTenantForCredit] = useState(null);
	const [creditAmount, setCreditAmount] = useState('100');
	const [creditReason, setCreditReason] = useState('Manual Bank Transfer Verified');
	const [searchLedger, setSearchLedger] = useState('');

	// Bank Details Editor State
	const [isEditBankOpen, setIsEditBankOpen] = useState(false);
	const [bankForm, setBankForm] = useState(platformBankDetails);

	const pendingRequests = depositRequests.filter((r) => r.status === 'pending');
	const totalCirculatingCredits = tenants.reduce((sum, t) => sum + (t.creditsBalance || 0), 0);
	const totalApprovedDeposits = depositRequests.filter((r) => r.status === 'approved').reduce((sum, r) => sum + r.amount, 0);

	const handleAdjustCredits = (e) => {
		e.preventDefault();
		if (!selectedTenantForCredit || !creditAmount) return;
		adjustMerchantCredits(selectedTenantForCredit.id, Number(creditAmount), creditReason);
		setSelectedTenantForCredit(null);
		setCreditAmount('100');
	};

	const handleSaveBankDetails = (e) => {
		e.preventDefault();
		updateBankDetails(bankForm);
		setIsEditBankOpen(false);
	};

	const handleExportCsv = () => {
		if (creditTransactions.length === 0) {
			showToast('No credit transactions available to export.', 'warning');
			return;
		}
		const headers = 'Transaction ID,Merchant,Type,Amount,Balance After,Method,Reference,Date\n';
		const rows = creditTransactions
			.map(
				(t) =>
					`${t.id},"${t.tenantName}",${t.type},${t.amount},${t.balanceAfter},"${t.method}","${t.reference}",${t.timestamp}`,
			)
			.join('\n');
		const blob = new Blob([headers + rows], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `credit-ledger-${new Date().toISOString().split('T')[0]}.csv`;
		a.click();
		URL.revokeObjectURL(url);
		showToast('Credit ledger exported to CSV.');
	};

	const filteredTransactions = creditTransactions.filter(
		(t) =>
			t.tenantName.toLowerCase().includes(searchLedger.toLowerCase()) ||
			t.reference.toLowerCase().includes(searchLedger.toLowerCase()) ||
			t.method.toLowerCase().includes(searchLedger.toLowerCase()),
	);

	return (
		<div className="space-y-6 antialiased">
			<PageHeader
				title="Credits & Subscriptions Management"
				subtitle="Merchant credit wallets, bank transfer deposit approvals, and ledger tracking"
				actions={
					<div className="flex items-center gap-2">
						{tenants.length > 0 && (
							<Button size="sm" onClick={() => setSelectedTenantForCredit(tenants[0])}>
								<Plus size={13} /> Add Merchant Credits
							</Button>
						)}
						<Button size="sm" variant="secondary" onClick={handleExportCsv}>
							<Download size={13} /> Export Ledger CSV
						</Button>
					</div>
				}
			/>

			{/* KPI Cards */}
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
				<StatCard
					label="Circulating Credits"
					value={`$${totalCirculatingCredits.toLocaleString()}.00`}
					change="Total merchant balances"
				/>
				<StatCard
					label="Pending Top-Ups"
					value={`${pendingRequests.length} Requests`}
					change={pendingRequests.length > 0 ? 'Awaiting verification' : 'All verified'}
				/>
				<StatCard
					label="Approved Bank Wires"
					value={`$${totalApprovedDeposits.toLocaleString()}.00`}
					change="Total funds received"
				/>
				<StatCard label="Active Stores" value={`${tenants.length} Merchants`} change="Enrolled in billing" />
			</div>

			{/* Navigation Tabs */}
			<div className="flex items-center gap-1.5 pb-2 border-b border-slate-200/80">
				<button
					type="button"
					onClick={() => setActiveTab('requests')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-1.5 ${
						activeTab === 'requests'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100/80 text-slate-600 hover:text-slate-900 hover:bg-slate-200/80'
					}`}>
					<Clock size={13} />
					<span>Bank Deposit Requests</span>
					{pendingRequests.length > 0 && (
						<span className="px-1.5 py-0.2 bg-amber-400 text-slate-950 font-bold rounded-full text-[10px]">
							{pendingRequests.length}
						</span>
					)}
				</button>

				<button
					type="button"
					onClick={() => setActiveTab('wallets')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-1.5 ${
						activeTab === 'wallets'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100/80 text-slate-600 hover:text-slate-900 hover:bg-slate-200/80'
					}`}>
					<Coins size={13} />
					<span>Merchant Credit Balances</span>
				</button>

				<button
					type="button"
					onClick={() => setActiveTab('ledger')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-1.5 ${
						activeTab === 'ledger'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100/80 text-slate-600 hover:text-slate-900 hover:bg-slate-200/80'
					}`}>
					<Download size={13} />
					<span>Transactions Ledger</span>
				</button>

				<button
					type="button"
					onClick={() => setActiveTab('bank_settings')}
					className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all duration-150 cursor-pointer flex items-center gap-1.5 ${
						activeTab === 'bank_settings'
							? 'bg-indigo-600 text-white shadow-xs'
							: 'bg-slate-100/80 text-slate-600 hover:text-slate-900 hover:bg-slate-200/80'
					}`}>
					<Building2 size={13} />
					<span>Platform Bank Account</span>
				</button>
			</div>

			{/* ─── TAB 1: BANK DEPOSIT REQUESTS APPROVAL QUEUE ─── */}
			{activeTab === 'requests' && (
				<div className="space-y-4">
					{depositRequests.length === 0 ? (
						<Card>
							<div className="py-16 text-center space-y-3">
								<div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
									<Clock size={24} />
								</div>
								<h3 className="font-bold text-sm text-slate-900">No Bank Transfer Requests</h3>
								<p className="text-xs text-slate-500 max-w-sm mx-auto">
									When merchants transfer funds to your bank and submit a top-up receipt, it will appear here for
									one-click verification.
								</p>
							</div>
						</Card>
					) : (
						<DataTable
							columns={[
								{
									key: 'id',
									label: 'Request ID',
									render: (v) => <span className="font-mono font-semibold text-xs text-slate-800">{v}</span>,
								},
								{
									key: 'tenantName',
									label: 'Merchant Store',
									render: (v) => <strong className="text-slate-900 text-xs font-semibold">{v}</strong>,
								},
								{
									key: 'amount',
									label: 'Amount (USD)',
									render: (v) => <span className="font-bold text-emerald-700 text-xs">+${v}.00</span>,
								},
								{
									key: 'bankName',
									label: 'Deposit Bank',
									render: (v) => <span className="text-xs text-slate-600">{v}</span>,
								},
								{
									key: 'transactionRef',
									label: 'Bank Reference / TRX ID',
									render: (v) => (
										<span className="font-mono text-xs text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-lg border border-indigo-100">
											{v}
										</span>
									),
								},
								{
									key: 'status',
									label: 'Status',
									render: (v) => (
										<Badge type={v === 'approved' ? 'success' : v === 'rejected' ? 'danger' : 'warning'}>
											{v.toUpperCase()}
										</Badge>
									),
								},
								{
									key: 'submittedAt',
									label: 'Date',
									render: (v) => <span className="text-xs text-slate-500">{v}</span>,
								},
								{
									key: 'actions',
									label: 'Review Action',
									render: (_, row) =>
										row.status === 'pending' ? (
											<div className="flex items-center gap-1.5">
												<button
													type="button"
													onClick={() => approveDepositRequest(row.id)}
													className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1 transition-all shadow-xs cursor-pointer active:scale-95">
													<CheckCircle2 size={12} /> Approve
												</button>
												<button
													type="button"
													onClick={() => rejectDepositRequest(row.id, 'Unverified bank wire')}
													className="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold flex items-center gap-1 transition-all border border-rose-200 cursor-pointer active:scale-95">
													<XCircle size={12} /> Reject
												</button>
											</div>
										) : (
											<span className="text-[11px] text-slate-400 font-medium">
												Reviewed on {row.reviewedAt || row.submittedAt}
											</span>
										),
								},
							]}
							data={depositRequests}
						/>
					)}
				</div>
			)}

			{/* ─── TAB 2: MERCHANT CREDIT BALANCES ─── */}
			{activeTab === 'wallets' && (
				<div className="space-y-4">
					{tenants.length === 0 ? (
						<Card>
							<div className="py-12 text-center text-xs text-slate-400 space-y-1">
								<Coins size={22} className="mx-auto text-slate-300 mb-1" />
								<p className="font-semibold text-slate-700">No Merchants Registered</p>
								<p>Add merchants in Merchant Management to govern their credit balances.</p>
							</div>
						</Card>
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
									label: 'Active Credit Balance',
									render: (v) => (
										<span
											className={`text-xs font-extrabold px-2.5 py-1 rounded-xl border ${
												v > 100
													? 'bg-emerald-50 text-emerald-800 border-emerald-200'
													: v > 0
														? 'bg-indigo-50 text-indigo-800 border-indigo-200'
														: 'bg-rose-50 text-rose-800 border-rose-200'
											}`}>
											${v}.00 USD
										</span>
									),
								},
								{
									key: 'plan',
									label: 'Current Plan',
									render: (v) => (
										<Badge type={v === 'enterprise' ? 'pro' : v === 'pro' ? 'info' : 'neutral'}>
											{v.toUpperCase()}
										</Badge>
									),
								},
								{
									key: 'mrr',
									label: 'Monthly Fee',
									render: (v) => <span className="font-semibold text-slate-900 text-xs">${v}/mo</span>,
								},
								{
									key: 'actions',
									label: 'Adjust Balance',
									render: (_, row) => (
										<button
											type="button"
											onClick={() => setSelectedTenantForCredit(row)}
											className="px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold transition-all border border-indigo-200 cursor-pointer flex items-center gap-1 active:scale-95">
											<Plus size={13} /> Add / Deduct Credits
										</button>
									),
								},
							]}
							data={tenants}
						/>
					)}
				</div>
			)}

			{/* ─── TAB 3: MASTER CREDIT TRANSACTIONS LEDGER ─── */}
			{activeTab === 'ledger' && (
				<div className="space-y-4">
					<div className="flex items-center gap-3 p-3 rounded-2xl bg-white border border-slate-200/80 shadow-xs">
						<Search size={15} className="text-slate-400" />
						<input
							type="text"
							placeholder="Search transactions by merchant, method, or reference ID..."
							value={searchLedger}
							onChange={(e) => setSearchLedger(e.target.value)}
							className="w-full text-xs text-slate-900 placeholder-slate-400 bg-transparent focus:outline-none"
						/>
					</div>

					{filteredTransactions.length === 0 ? (
						<Card>
							<div className="py-12 text-center text-xs text-slate-400 space-y-1">
								<p className="font-semibold text-slate-700">No Transactions Logged</p>
								<p>All credit deposits and deductions will be permanently recorded here.</p>
							</div>
						</Card>
					) : (
						<DataTable
							columns={[
								{
									key: 'id',
									label: 'Tx ID',
									render: (v) => <span className="font-mono text-xs text-slate-700 font-semibold">{v}</span>,
								},
								{
									key: 'tenantName',
									label: 'Merchant',
									render: (v) => <strong className="text-slate-900 text-xs font-semibold">{v}</strong>,
								},
								{
									key: 'type',
									label: 'Type',
									render: (v) => <Badge type={v === 'deposit' ? 'success' : 'warning'}>{v.toUpperCase()}</Badge>,
								},
								{
									key: 'amount',
									label: 'Amount',
									render: (v, row) => (
										<span
											className={`font-bold text-xs ${row.type === 'deposit' ? 'text-emerald-700' : 'text-slate-900'}`}>
											{row.type === 'deposit' ? '+' : '-'}${v}.00
										</span>
									),
								},
								{
									key: 'balanceAfter',
									label: 'Balance After',
									render: (v) => <span className="font-semibold text-slate-900 text-xs">${v}.00</span>,
								},
								{ key: 'method', label: 'Payment Channel' },
								{
									key: 'reference',
									label: 'Reference / Reason',
									render: (v) => <span className="font-mono text-[11px] text-slate-600">{v}</span>,
								},
								{ key: 'timestamp', label: 'Date' },
							]}
							data={filteredTransactions}
						/>
					)}
				</div>
			)}

			{/* ─── TAB 4: PLATFORM BANK ACCOUNT DETAILS ─── */}
			{activeTab === 'bank_settings' && (
				<div className="max-w-2xl space-y-4">
					<Card
						title="Official Platform Bank Details"
						subtitle="These credentials are shown to merchants when they make bank transfer top-up requests"
						action={
							<Button size="sm" onClick={() => setIsEditBankOpen(true)}>
								Edit Bank Information
							</Button>
						}>
						<div className="p-5 rounded-2xl bg-slate-50 border border-slate-200 space-y-3 text-xs">
							<div className="flex justify-between py-1 border-b border-slate-200/60">
								<span className="text-slate-500">Bank Name:</span>
								<span className="font-bold text-slate-900">{platformBankDetails.bankName}</span>
							</div>
							<div className="flex justify-between py-1 border-b border-slate-200/60">
								<span className="text-slate-500">Account Title:</span>
								<span className="font-bold text-slate-900">{platformBankDetails.accountTitle}</span>
							</div>
							<div className="flex justify-between py-1 border-b border-slate-200/60">
								<span className="text-slate-500">Account Number:</span>
								<span className="font-mono font-bold text-slate-900">{platformBankDetails.accountNumber}</span>
							</div>
							<div className="flex justify-between py-1 border-b border-slate-200/60">
								<span className="text-slate-500">IBAN:</span>
								<span className="font-mono font-bold text-slate-900">{platformBankDetails.iban}</span>
							</div>
							<div className="flex justify-between py-1 border-b border-slate-200/60">
								<span className="text-slate-500">SWIFT / BIC:</span>
								<span className="font-mono font-bold text-slate-900">{platformBankDetails.swift}</span>
							</div>
							<div className="pt-2">
								<span className="text-slate-500 block mb-1">Transfer Instructions for Merchants:</span>
								<p className="text-xs text-slate-700 bg-white p-3 rounded-xl border border-slate-200 leading-relaxed">
									{platformBankDetails.instructions}
								</p>
							</div>
						</div>
					</Card>
				</div>
			)}

			{/* Manual Add / Adjust Credits Modal */}
			<Modal
				title={`Adjust Credit Balance: ${selectedTenantForCredit?.name || ''}`}
				isOpen={!!selectedTenantForCredit}
				onClose={() => setSelectedTenantForCredit(null)}
				footer={
					<>
						<Button variant="secondary" onClick={() => setSelectedTenantForCredit(null)}>
							Cancel
						</Button>
						<Button onClick={handleAdjustCredits}>Apply Credit Adjustment</Button>
					</>
				}>
				{selectedTenantForCredit && (
					<form onSubmit={handleAdjustCredits} className="space-y-4 text-xs">
						<div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex justify-between items-center">
							<span className="text-slate-500">Current Wallet Balance:</span>
							<span className="font-bold text-sm text-slate-900">
								${selectedTenantForCredit.creditsBalance || 0}.00 USD
							</span>
						</div>

						<div>
							<Label>Amount to Add (or negative to deduct)</Label>
							<Input
								type="number"
								required
								value={creditAmount}
								onChange={(e) => setCreditAmount(e.target.value)}
								placeholder="e.g. 250"
							/>
						</div>

						<div>
							<Label>Adjustment Reason / Verification Reference</Label>
							<Input
								required
								value={creditReason}
								onChange={(e) => setCreditReason(e.target.value)}
								placeholder="e.g. Verified Wire Transfer #TRX-88912"
							/>
						</div>
					</form>
				)}
			</Modal>

			{/* Edit Platform Bank Details Modal */}
			<Modal
				title="Configure Platform Bank Details"
				isOpen={isEditBankOpen}
				onClose={() => setIsEditBankOpen(false)}
				footer={
					<>
						<Button variant="secondary" onClick={() => setIsEditBankOpen(false)}>
							Cancel
						</Button>
						<Button onClick={handleSaveBankDetails}>Save Bank Credentials</Button>
					</>
				}>
				<form onSubmit={handleSaveBankDetails} className="space-y-4 text-xs">
					<div>
						<Label>Bank Name</Label>
						<Input
							required
							value={bankForm.bankName}
							onChange={(e) => setBankForm({ ...bankForm, bankName: e.target.value })}
						/>
					</div>

					<div>
						<Label>Account Title</Label>
						<Input
							required
							value={bankForm.accountTitle}
							onChange={(e) => setBankForm({ ...bankForm, accountTitle: e.target.value })}
						/>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div>
							<Label>Account Number</Label>
							<Input
								required
								value={bankForm.accountNumber}
								onChange={(e) => setBankForm({ ...bankForm, accountNumber: e.target.value })}
							/>
						</div>
						<div>
							<Label>SWIFT / BIC</Label>
							<Input value={bankForm.swift} onChange={(e) => setBankForm({ ...bankForm, swift: e.target.value })} />
						</div>
					</div>

					<div>
						<Label>IBAN Number</Label>
						<Input required value={bankForm.iban} onChange={(e) => setBankForm({ ...bankForm, iban: e.target.value })} />
					</div>

					<div>
						<Label>Instructions for Merchants</Label>
						<Input
							value={bankForm.instructions}
							onChange={(e) => setBankForm({ ...bankForm, instructions: e.target.value })}
						/>
					</div>
				</form>
			</Modal>
		</div>
	);
}
