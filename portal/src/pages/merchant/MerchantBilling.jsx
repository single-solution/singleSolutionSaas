import React, { useState } from 'react';
import { Coins, Building2, Copy, CheckCircle2, Clock, Plus, AlertCircle, ArrowUpRight } from 'lucide-react';
import { PageHeader } from '@saas/ui/layout/PageHeader';
import { StatCard } from '@saas/ui/cards/StatCard';
import { DataTable } from '@saas/ui/tables/Table';
import { Badge } from '@saas/ui/badges/Badge';
import { Button } from '@saas/ui/buttons/Button';
import { Modal } from '@saas/ui/modals/Modal';
import { Card } from '@saas/ui/cards/Card';
import { Input, Label } from '@saas/ui/inputs/TextInput';
import { usePortal } from '../../context/PortalContext';

export default function MerchantBilling() {
	const { activeTenant, depositRequests, creditTransactions, platformBankDetails, requestBankDeposit, showToast } = usePortal();

	const [isTopUpOpen, setIsTopUpOpen] = useState(false);
	const [copiedField, setCopiedField] = useState(null);

	const [topUpForm, setTopUpForm] = useState({
		amount: '250',
		bankName: 'Meezan Bank',
		transactionRef: '',
		notes: '',
	});

	if (!activeTenant) {
		return (
			<Card>
				<div className="py-16 text-center space-y-3">
					<div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
						<Coins size={24} />
					</div>
					<h3 className="font-bold text-sm text-slate-900">No Merchant Storefront Selected</h3>
					<p className="text-xs text-slate-500 max-w-sm mx-auto">
						Please sign in to a merchant storefront account to view your credit balance and top up via bank transfer.
					</p>
				</div>
			</Card>
		);
	}

	const merchantDeposits = depositRequests.filter((r) => r.tenantId === activeTenant.id);
	const merchantTxs = creditTransactions.filter((t) => t.tenantId === activeTenant.id);

	const currentCredits = activeTenant.creditsBalance || 0;
	const isLowBalance = currentCredits < (activeTenant.mrr || 99);

	const handleCopy = (text, fieldName) => {
		navigator.clipboard.writeText(text);
		setCopiedField(fieldName);
		showToast(`Copied ${fieldName} to clipboard.`);
		setTimeout(() => setCopiedField(null), 2000);
	};

	const handleTopUpSubmit = (e) => {
		e.preventDefault();
		if (!topUpForm.amount || !topUpForm.transactionRef.trim()) {
			showToast('Please provide the deposit amount and bank transaction reference.', 'warning');
			return;
		}

		requestBankDeposit({
			tenantId: activeTenant.id,
			amount: Number(topUpForm.amount),
			bankName: topUpForm.bankName,
			transactionRef: topUpForm.transactionRef,
			notes: topUpForm.notes,
		});

		setIsTopUpOpen(false);
		setTopUpForm({ amount: '250', bankName: 'Meezan Bank', transactionRef: '', notes: '' });
	};

	return (
		<div className="space-y-6 antialiased">
			<PageHeader
				title="Storefront Wallet & Subscriptions"
				subtitle={`Prepaid credit balance and bank transfer top-up for ${activeTenant.name}`}
				actions={
					<Button onClick={() => setIsTopUpOpen(true)}>
						<Plus size={14} /> Top Up Credits via Bank Wire
					</Button>
				}
			/>

			{/* Low Balance Warning Alert */}
			{isLowBalance && (
				<div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-3">
					<AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
					<div className="space-y-1">
						<div className="font-bold">Low Credit Balance Notice</div>
						<p className="text-amber-800 leading-relaxed">
							Your current balance is <strong>${currentCredits}.00</strong>. Your monthly subscription requires{' '}
							<strong>${activeTenant.mrr}.00</strong>. Please transfer funds to the platform bank account below and submit
							a top-up request to keep your micro-apps active.
						</p>
					</div>
				</div>
			)}

			{/* KPI Stats */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard label="Available Credits" value={`$${currentCredits}.00 USD`} change="Prepaid Wallet Balance" />
				<StatCard
					label="Monthly Plan Requirement"
					value={`$${activeTenant.mrr}.00`}
					change={`${activeTenant.plan?.toUpperCase()} Tier`}
				/>
				<StatCard label="Payment Method" value="Manual Bank Transfer" change="Wire Verification" />
			</div>

			{/* Official Platform Bank Details Card */}
			<Card
				title="Platform Bank Transfer Details"
				subtitle="Transfer funds directly to this bank account and submit your transaction reference to receive instant credits"
				action={
					<Button size="sm" onClick={() => setIsTopUpOpen(true)}>
						<ArrowUpRight size={13} /> Submit Deposit Receipt
					</Button>
				}>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5 text-xs">
						<div className="flex justify-between items-center py-1 border-b border-slate-200/60">
							<span className="text-slate-500">Bank Name:</span>
							<span className="font-bold text-slate-900">{platformBankDetails.bankName}</span>
						</div>
						<div className="flex justify-between items-center py-1 border-b border-slate-200/60">
							<span className="text-slate-500">Account Title:</span>
							<span className="font-bold text-slate-900">{platformBankDetails.accountTitle}</span>
						</div>
						<div className="flex justify-between items-center py-1 border-b border-slate-200/60">
							<span className="text-slate-500">Account Number:</span>
							<div className="flex items-center gap-1.5">
								<span className="font-mono font-bold text-slate-900">{platformBankDetails.accountNumber}</span>
								<button
									type="button"
									onClick={() => handleCopy(platformBankDetails.accountNumber, 'Account Number')}
									className="text-slate-400 hover:text-indigo-600 cursor-pointer">
									{copiedField === 'Account Number' ? (
										<CheckCircle2 size={12} className="text-emerald-600" />
									) : (
										<Copy size={12} />
									)}
								</button>
							</div>
						</div>
						<div className="flex justify-between items-center py-1">
							<span className="text-slate-500">SWIFT / BIC:</span>
							<span className="font-mono font-bold text-slate-900">{platformBankDetails.swift}</span>
						</div>
					</div>

					<div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5 text-xs">
						<div className="flex justify-between items-center py-1 border-b border-slate-200/60">
							<span className="text-slate-500">IBAN Number:</span>
							<div className="flex items-center gap-1.5">
								<span className="font-mono font-bold text-slate-900 text-[11px]">{platformBankDetails.iban}</span>
								<button
									type="button"
									onClick={() => handleCopy(platformBankDetails.iban, 'IBAN')}
									className="text-slate-400 hover:text-indigo-600 cursor-pointer">
									{copiedField === 'IBAN' ? <CheckCircle2 size={12} className="text-emerald-600" /> : <Copy size={12} />}
								</button>
							</div>
						</div>
						<div className="flex justify-between items-center py-1 border-b border-slate-200/60">
							<span className="text-slate-500">Your Merchant ID:</span>
							<div className="flex items-center gap-1.5">
								<span className="font-mono font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
									{activeTenant.id}
								</span>
								<button
									type="button"
									onClick={() => handleCopy(activeTenant.id, 'Merchant ID')}
									className="text-slate-400 hover:text-indigo-600 cursor-pointer">
									{copiedField === 'Merchant ID' ? (
										<CheckCircle2 size={12} className="text-emerald-600" />
									) : (
										<Copy size={12} />
									)}
								</button>
							</div>
						</div>
						<div className="pt-1">
							<span className="text-slate-500 block text-[11px] mb-1">Transfer Memo Note:</span>
							<p className="text-[11px] text-slate-700 leading-relaxed">{platformBankDetails.instructions}</p>
						</div>
					</div>
				</div>
			</Card>

			{/* Bank Deposit Requests Queue */}
			<Card title="Your Bank Transfer Top-Up Requests">
				{merchantDeposits.length === 0 ? (
					<div className="py-8 text-center text-xs text-slate-400 space-y-2">
						<Building2 size={22} className="mx-auto text-slate-300 mb-1" />
						<p className="font-semibold text-slate-700">No Bank Transfer Requests Submitted</p>
						<p>When you transfer funds to our bank account, click &ldquo;Top Up Credits&rdquo; to submit proof.</p>
					</div>
				) : (
					<DataTable
						columns={[
							{
								key: 'id',
								label: 'Request ID',
								render: (v) => <span className="font-mono text-xs text-slate-700 font-semibold">{v}</span>,
							},
							{
								key: 'amount',
								label: 'Amount',
								render: (v) => <span className="font-bold text-emerald-700 text-xs">+${v}.00</span>,
							},
							{ key: 'bankName', label: 'Bank Name' },
							{
								key: 'transactionRef',
								label: 'Reference / TRX ID',
								render: (v) => (
									<span className="font-mono text-xs text-slate-800 bg-slate-100 px-2 py-0.5 rounded">{v}</span>
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
							{ key: 'submittedAt', label: 'Submitted Date' },
						]}
						data={merchantDeposits}
					/>
				)}
			</Card>

			{/* Credit Wallet Transactions Ledger */}
			<Card title="Wallet Credit Ledger & History">
				{merchantTxs.length === 0 ? (
					<div className="py-8 text-center text-xs text-slate-400 space-y-1">
						<p className="font-semibold text-slate-700">No Credit Transactions Yet</p>
						<p>Approved bank deposits and subscription deductions will be listed here.</p>
					</div>
				) : (
					<DataTable
						columns={[
							{
								key: 'id',
								label: 'Tx ID',
								render: (v) => <span className="font-mono text-xs text-slate-700 font-semibold">{v}</span>,
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
								label: 'Wallet Balance',
								render: (v) => <span className="font-semibold text-slate-900 text-xs">${v}.00</span>,
							},
							{ key: 'method', label: 'Channel' },
							{
								key: 'reference',
								label: 'Reference / Reason',
								render: (v) => <span className="font-mono text-[11px] text-slate-600">{v}</span>,
							},
							{ key: 'timestamp', label: 'Date' },
						]}
						data={merchantTxs}
					/>
				)}
			</Card>

			{/* Top-Up Credits via Bank Transfer Modal */}
			<Modal
				title="Top Up Credits via Bank Transfer"
				isOpen={isTopUpOpen}
				onClose={() => setIsTopUpOpen(false)}
				footer={
					<>
						<Button variant="secondary" onClick={() => setIsTopUpOpen(false)}>
							Cancel
						</Button>
						<Button onClick={handleTopUpSubmit}>Submit Deposit Proof</Button>
					</>
				}>
				<form onSubmit={handleTopUpSubmit} className="space-y-4 text-xs">
					<div className="p-3 rounded-xl bg-indigo-50/70 border border-indigo-100 text-indigo-900 space-y-1">
						<div className="font-bold flex items-center gap-1.5">
							<Building2 size={14} className="text-indigo-600" />
							<span>Transfer funds to {platformBankDetails.bankName}</span>
						</div>
						<div className="font-mono text-[11px]">
							IBAN: <strong>{platformBankDetails.iban}</strong>
						</div>
						<div className="text-[10px] text-indigo-700">Account Title: {platformBankDetails.accountTitle}</div>
					</div>

					<div>
						<Label>Deposit Amount (USD)</Label>
						<div className="grid grid-cols-4 gap-2 mb-2">
							{['100', '250', '500', '1000'].map((preset) => (
								<button
									type="button"
									key={preset}
									onClick={() => setTopUpForm({ ...topUpForm, amount: preset })}
									className={`py-1.5 rounded-lg font-bold text-xs transition-all cursor-pointer ${
										topUpForm.amount === preset
											? 'bg-indigo-600 text-white shadow-xs'
											: 'bg-slate-100 text-slate-700 hover:bg-slate-200'
									}`}>
									${preset}
								</button>
							))}
						</div>
						<Input
							type="number"
							required
							value={topUpForm.amount}
							onChange={(e) => setTopUpForm({ ...topUpForm, amount: e.target.value })}
							placeholder="Enter amount"
						/>
					</div>

					<div>
						<Label>Your Sender Bank Name</Label>
						<Input
							required
							placeholder="e.g. HBL / Meezan / Chase Bank"
							value={topUpForm.bankName}
							onChange={(e) => setTopUpForm({ ...topUpForm, bankName: e.target.value })}
						/>
					</div>

					<div>
						<Label>Bank Transaction Reference / Deposit Slip TRX ID</Label>
						<Input
							required
							placeholder="e.g. TRX-99281293847"
							value={topUpForm.transactionRef}
							onChange={(e) => setTopUpForm({ ...topUpForm, transactionRef: e.target.value })}
						/>
					</div>

					<div>
						<Label>Additional Notes (Optional)</Label>
						<Input
							placeholder="e.g. Sent from John Doe business account"
							value={topUpForm.notes}
							onChange={(e) => setTopUpForm({ ...topUpForm, notes: e.target.value })}
						/>
					</div>
				</form>
			</Modal>
		</div>
	);
}
