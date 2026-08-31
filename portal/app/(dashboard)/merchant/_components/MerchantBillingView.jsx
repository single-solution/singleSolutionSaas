'use client';

import React, { useState } from 'react';
import { usePortal } from '../../../../context/PortalContext';
import { Coins, Plus, Building2, Clock, CheckCircle, ArrowUpRight, FileText, Printer, AlertTriangle } from 'lucide-react';

export default function MerchantBillingView() {
	const {
		activeTenant,
		depositRequests = [],
		platformBankDetails,
		requestBankDeposit,
		calculateMerchantMonthlyFee,
	} = usePortal();

	const [isDepositOpen, setIsDepositOpen] = useState(false);
	const [selectedReceipt, setSelectedReceipt] = useState(null);
	const [amount, setAmount] = useState('500');
	const [bankName, setBankName] = useState('Meezan Bank');
	const [trxRef, setTrxRef] = useState('');
	const [notes, setNotes] = useState('');

	const monthlyBurn = calculateMerchantMonthlyFee(activeTenant);
	const tenantDeposits = depositRequests.filter((d) => d.tenantId === activeTenant?.id);

	const handleDepositSubmit = async (e) => {
		e.preventDefault();
		if (!activeTenant) return;
		await requestBankDeposit({
			tenantId: activeTenant.id,
			amount: Number(amount),
			bankName,
			transactionRef: trxRef,
			notes,
		});
		setTrxRef('');
		setNotes('');
		setIsDepositOpen(false);
	};

	return (
		<div className="space-y-6 max-w-4xl">
			<div>
				<h1 className="text-xl font-bold text-slate-900 tracking-tight">Store Wallet & Bank Topups</h1>
				<p className="text-xs text-slate-500">
					Manage store credit balance, review wire transfer deposits, and track monthly usage
				</p>
			</div>

			{/* Wallet Cards */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-2">
					<div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
						<span>Available Float</span>
						<Coins size={16} className="text-amber-500" />
					</div>
					<div className="text-3xl font-extrabold text-slate-900 tracking-tight">${activeTenant?.creditsBalance || 0}</div>
					<div className="text-[11px] text-slate-400">Current store balance</div>
				</div>

				<div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-2">
					<div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
						<span>Monthly Fee Rate</span>
						<ArrowUpRight size={16} className="text-indigo-500" />
					</div>
					<div className="text-3xl font-extrabold text-indigo-600 tracking-tight">
						${monthlyBurn} <span className="text-xs font-medium text-slate-400">/ mo</span>
					</div>
					<div className="text-[11px] text-slate-400">Based on active licensed features</div>
				</div>

				<div className="p-5 rounded-2xl bg-linear-to-br from-indigo-600 to-indigo-800 text-white shadow-md flex flex-col justify-between space-y-3">
					<div>
						<div className="text-xs font-bold text-indigo-200 uppercase tracking-wider">Topup Credits</div>
						<div className="text-sm font-bold mt-1">Bank Wire Deposit</div>
					</div>
					<button
						type="button"
						onClick={() => setIsDepositOpen(true)}
						className="py-2 px-4 rounded-xl bg-white text-indigo-700 font-bold text-xs hover:bg-indigo-50 transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xs">
						<Plus size={14} />
						<span>Submit Deposit Receipt</span>
					</button>
				</div>
			</div>

			{/* Bank Transfer Instructions */}
			{platformBankDetails && (
				<div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-4">
					<div className="flex items-center gap-3">
						<div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
							<Building2 size={20} />
						</div>
						<div>
							<h3 className="text-xs font-bold text-slate-900">Official Clearing Bank Account</h3>
							<p className="text-[11px] text-slate-500">
								Transfer funds to our corporate clearing account and submit the transaction reference number below
							</p>
						</div>
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 rounded-xl bg-slate-50 border border-slate-200/60 text-xs">
						<div>
							<span className="text-[10px] font-bold text-slate-400 uppercase">Bank</span>
							<div className="font-bold text-slate-800 mt-0.5">{platformBankDetails.bankName}</div>
						</div>
						<div>
							<span className="text-[10px] font-bold text-slate-400 uppercase">Account Title</span>
							<div className="font-bold text-slate-800 mt-0.5">{platformBankDetails.accountTitle}</div>
						</div>
						<div>
							<span className="text-[10px] font-bold text-slate-400 uppercase">IBAN / Account #</span>
							<div className="font-bold font-mono text-indigo-700 mt-0.5">
								{platformBankDetails.iban || platformBankDetails.accountNumber}
							</div>
						</div>
					</div>

					{platformBankDetails.instructions && (
						<p className="text-[11px] text-slate-500 italic bg-amber-50/50 p-2.5 rounded-xl border border-amber-200/60">
							<strong>Instruction:</strong> {platformBankDetails.instructions}
						</p>
					)}
				</div>
			)}

			{/* Deposit Requests Table */}
			<div className="space-y-3">
				<h2 className="text-sm font-bold text-slate-900">Your Deposit Verification History</h2>
				<div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
					{tenantDeposits.length > 0 ? (
						<table className="w-full text-left text-xs">
							<thead>
								<tr className="border-b border-slate-100 bg-slate-50/50 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
									<th className="py-3 px-4">Request ID</th>
									<th className="py-3 px-4">Amount</th>
									<th className="py-3 px-4">Bank / Reference</th>
									<th className="py-3 px-4">Status</th>
									<th className="py-3 px-4 text-right">Actions / Date</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-slate-100 font-medium text-slate-700">
								{tenantDeposits.map((req) => (
									<tr key={req.id} className="hover:bg-slate-50/60 transition-colors">
										<td className="py-3 px-4 font-mono font-bold text-slate-900">{req.id}</td>
										<td className="py-3 px-4 font-extrabold text-emerald-600">${req.amount}</td>
										<td className="py-3 px-4">
											<div>{req.bankName}</div>
											<div className="text-[10px] text-slate-400 font-mono">{req.transactionRef}</div>
										</td>
										<td className="py-3 px-4">
											<span
												className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
													req.status === 'approved'
														? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
														: req.status === 'rejected'
															? 'bg-rose-50 text-rose-700 border border-rose-200'
															: 'bg-amber-50 text-amber-700 border border-amber-200'
												}`}>
												{req.status}
											</span>
											{req.rejectionReason && (
												<div className="text-[10px] text-rose-600 mt-0.5">{req.rejectionReason}</div>
											)}
										</td>
										<td className="py-3 px-4 text-right">
											<button
												type="button"
												onClick={() => setSelectedReceipt(req)}
												className="inline-flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-800 font-bold cursor-pointer">
												<FileText size={12} />
												<span>Receipt</span>
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<div className="p-8 text-center text-xs text-slate-400">No wire deposit requests submitted yet.</div>
					)}
				</div>
			</div>

			{/* Receipt View Modal */}
			{selectedReceipt && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<h3 className="text-sm font-bold text-slate-900">Wire Deposit Slip: {selectedReceipt.id}</h3>
							<button onClick={() => setSelectedReceipt(null)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						<div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-3 text-xs">
							<div className="flex justify-between">
								<span className="text-slate-500">Store Name:</span>
								<span className="font-bold text-slate-900">{selectedReceipt.tenantName}</span>
							</div>
							<div className="flex justify-between">
								<span className="text-slate-500">Deposit Amount:</span>
								<span className="font-extrabold text-emerald-600 text-sm">${selectedReceipt.amount}</span>
							</div>
							<div className="flex justify-between">
								<span className="text-slate-500">Sending Bank:</span>
								<span className="font-medium text-slate-900">{selectedReceipt.bankName}</span>
							</div>
							<div className="flex justify-between">
								<span className="text-slate-500">Transaction Reference:</span>
								<span className="font-mono font-bold text-slate-900">{selectedReceipt.transactionRef}</span>
							</div>
							<div className="flex justify-between">
								<span className="text-slate-500">Current Status:</span>
								<span className="font-bold uppercase text-[11px] text-indigo-700">{selectedReceipt.status}</span>
							</div>
							<div className="flex justify-between">
								<span className="text-slate-500">Submission Date:</span>
								<span className="text-slate-700">{new Date(selectedReceipt.submittedAt).toLocaleString()}</span>
							</div>
						</div>

						<div className="flex justify-end gap-2 pt-2">
							<button
								type="button"
								onClick={() => window.print()}
								className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs flex items-center gap-1.5 cursor-pointer">
								<Printer size={13} />
								<span>Print</span>
							</button>
							<button
								type="button"
								onClick={() => setSelectedReceipt(null)}
								className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs">
								Close
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Topup Modal */}
			{isDepositOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<h3 className="text-sm font-bold text-slate-900">Submit Wire Deposit Receipt</h3>
							<button onClick={() => setIsDepositOpen(false)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						<form onSubmit={handleDepositSubmit} className="space-y-4 text-xs">
							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Deposit Amount ($)</label>
								<input
									type="number"
									required
									min="10"
									value={amount}
									onChange={(e) => setAmount(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-bold outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Sending Bank</label>
								<input
									type="text"
									required
									value={bankName}
									onChange={(e) => setBankName(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
									Bank Transaction Reference / Cheque #
								</label>
								<input
									type="text"
									required
									placeholder="e.g. TRX-991823901"
									value={trxRef}
									onChange={(e) => setTrxRef(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-[11px] outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Notes (Optional)</label>
								<textarea
									rows={2}
									placeholder="Branch name or payer details..."
									value={notes}
									onChange={(e) => setNotes(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500 resize-none"
								/>
							</div>

							<div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
								<button
									type="button"
									onClick={() => setIsDepositOpen(false)}
									className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold">
									Cancel
								</button>
								<button
									type="submit"
									className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-xs">
									Submit for Verification
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
