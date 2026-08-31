'use client';

import React, { useState } from 'react';
import { usePortal } from '../../../../context/PortalContext';
import { Check, X, Coins, CheckCircle, Clock, Building2, AlertCircle, ArrowUpRight, Search, Plus, PlayCircle } from 'lucide-react';

export default function BillingLedger() {
	const {
		depositRequests = [],
		creditTransactions = [],
		tenants = [],
		approveDepositRequest,
		rejectDepositRequest,
		grantAdminCredits,
		platformBankDetails,
	} = usePortal();

	const [rejectModalRequest, setRejectModalRequest] = useState(null);
	const [rejectReason, setRejectReason] = useState('Bank statement deposit reference unconfirmed');

	const pendingDeposits = depositRequests.filter((d) => d.status === 'pending');
	const verifiedDeposits = depositRequests.filter((d) => d.status !== 'pending');

	const totalFloatInCirculation = tenants.reduce((acc, t) => acc + (Number(t.creditsBalance) || 0), 0);
	const totalDepositsApproved = depositRequests
		.filter((d) => d.status === 'approved')
		.reduce((acc, d) => acc + (Number(d.amount) || 0), 0);

	const handleRejectSubmit = async (e) => {
		e.preventDefault();
		if (!rejectModalRequest) return;
		await rejectDepositRequest(rejectModalRequest.id, rejectReason);
		setRejectModalRequest(null);
	};

	return (
		<div className="space-y-6">
			{/* Top Summary Cards */}
			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-2">
					<div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
						<span>Total Deposits Verified</span>
						<CheckCircle size={16} className="text-emerald-500" />
					</div>
					<div className="text-3xl font-extrabold text-slate-900 tracking-tight">${totalDepositsApproved}</div>
					<div className="text-[11px] text-slate-400">Approved bank wire deposits</div>
				</div>

				<div className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-2">
					<div className="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
						<span>Active Float in Circulation</span>
						<Coins size={16} className="text-amber-500" />
					</div>
					<div className="text-3xl font-extrabold text-indigo-600 tracking-tight">${totalFloatInCirculation}</div>
					<div className="text-[11px] text-slate-400">Across {tenants.length} registered merchant stores</div>
				</div>
			</div>

			{/* Pending Deposit Approvals Queue */}
			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
						<span>Pending Wire Deposit Verifications</span>
						{pendingDeposits.length > 0 && (
							<span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-extrabold">
								{pendingDeposits.length} Awaiting Review
							</span>
						)}
					</h2>
				</div>

				<div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
					{pendingDeposits.length > 0 ? (
						<div className="divide-y divide-slate-100">
							{pendingDeposits.map((req) => (
								<div key={req.id} className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
									<div className="space-y-1">
										<div className="flex items-center gap-2">
											<span className="font-mono font-bold text-xs text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md">
												{req.id}
											</span>
											<span className="font-bold text-sm text-slate-900">{req.tenantName}</span>
											<span className="text-[10px] text-slate-400 font-mono">({req.tenantId})</span>
										</div>
										<div className="text-xs text-slate-600 flex flex-wrap items-center gap-3">
											<span>
												Bank: <strong className="text-slate-900">{req.bankName}</strong>
											</span>
											<span>•</span>
											<span>
												Ref: <strong className="font-mono text-slate-900">{req.transactionRef}</strong>
											</span>
											<span>•</span>
											<span>Date: {new Date(req.submittedAt).toLocaleString()}</span>
										</div>
										{req.notes && (
											<div className="text-[11px] text-slate-500 italic bg-slate-50 p-2 rounded-lg mt-1">
												&ldquo;{req.notes}&rdquo;
											</div>
										)}
									</div>

									<div className="flex items-center gap-3 shrink-0">
										<div className="text-right mr-2">
											<div className="text-lg font-black text-emerald-600">+${req.amount}</div>
											<div className="text-[10px] text-slate-400 uppercase font-bold">Credit Amount</div>
										</div>
										<button
											type="button"
											onClick={() => approveDepositRequest(req.id)}
											className="py-2 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs transition-all cursor-pointer">
											<Check size={14} />
											<span>Approve & Credit</span>
										</button>
										<button
											type="button"
											onClick={() => setRejectModalRequest(req)}
											className="py-2 px-3.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer">
											<X size={14} />
											<span>Reject</span>
										</button>
									</div>
								</div>
							))}
						</div>
					) : (
						<div className="py-8 text-center text-xs text-slate-400">
							No pending deposit verification receipts waiting for review.
						</div>
					)}
				</div>
			</div>

			{/* Deposit History & Transactions Ledger */}
			<div className="space-y-3">
				<h2 className="text-sm font-bold text-slate-900">Historical Deposits & Transaction Logs</h2>
				<div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
					<div className="overflow-x-auto">
						<table className="w-full text-left text-xs">
							<thead>
								<tr className="border-b border-slate-100 bg-slate-50/50 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
									<th className="py-3 px-4">Receipt / Tx</th>
									<th className="py-3 px-4">Store Name</th>
									<th className="py-3 px-4">Amount</th>
									<th className="py-3 px-4">Bank / Method</th>
									<th className="py-3 px-4">Status</th>
									<th className="py-3 px-4 text-right">Processed At</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-slate-100 font-medium text-slate-700">
								{verifiedDeposits.length > 0 ? (
									verifiedDeposits.map((req) => {
										const isApproved = req.status === 'approved';
										return (
											<tr key={req.id} className="hover:bg-slate-50/60 transition-colors">
												<td className="py-3.5 px-4 font-mono font-bold text-slate-900">{req.id}</td>
												<td className="py-3.5 px-4">
													<div className="font-bold text-slate-900">{req.tenantName}</div>
													<div className="text-[10px] text-slate-400 font-mono">{req.tenantId}</div>
												</td>
												<td className="py-3.5 px-4 font-bold text-slate-900">${req.amount}</td>
												<td className="py-3.5 px-4">
													<div>{req.bankName}</div>
													<div className="text-[10px] font-mono text-slate-400">{req.transactionRef}</div>
												</td>
												<td className="py-3.5 px-4">
													<span
														className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
															isApproved
																? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
																: 'bg-rose-50 text-rose-700 border border-rose-200'
														}`}>
														{req.status}
													</span>
													{req.rejectionReason && (
														<div className="text-[10px] text-rose-600 mt-0.5">{req.rejectionReason}</div>
													)}
												</td>
												<td className="py-3.5 px-4 text-right font-mono text-[11px] text-slate-400">
													{req.approvedAt || req.rejectedAt
														? new Date(req.approvedAt || req.rejectedAt).toLocaleString()
														: new Date(req.submittedAt).toLocaleDateString()}
												</td>
											</tr>
										);
									})
								) : (
									<tr>
										<td colSpan={6} className="py-8 text-center text-xs text-slate-400">
											No deposit transactions recorded yet.
										</td>
									</tr>
								)}
							</tbody>
						</table>
					</div>
				</div>
			</div>

			{/* Reject Modal */}
			{rejectModalRequest && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<h3 className="text-sm font-bold text-slate-900">Reject Deposit Request</h3>
							<button onClick={() => setRejectModalRequest(null)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						<form onSubmit={handleRejectSubmit} className="space-y-4 text-xs">
							<p className="text-slate-600">
								Are you sure you want to reject request <strong>{rejectModalRequest.id}</strong> for{' '}
								<strong>${rejectModalRequest.amount}</strong>?
							</p>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Reason for Rejection</label>
								<input
									type="text"
									required
									value={rejectReason}
									onChange={(e) => setRejectReason(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
								<button
									type="button"
									onClick={() => setRejectModalRequest(null)}
									className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold">
									Cancel
								</button>
								<button
									type="submit"
									className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold shadow-xs">
									Confirm Rejection
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
