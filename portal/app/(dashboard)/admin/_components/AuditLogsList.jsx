'use client';

import React, { useState } from 'react';
import { usePortal } from '../../../../context/PortalContext';
import { Clock, ShieldAlert, CheckCircle, Info, RefreshCw, Download, Search, AlertTriangle } from 'lucide-react';

export default function AuditLogsList() {
	const { auditLogs = [], refreshAuditLogs } = usePortal();
	const [levelFilter, setLevelFilter] = useState('all');
	const [searchTerm, setSearchTerm] = useState('');
	const [isRefreshing, setIsRefreshing] = useState(false);

	const handleRefresh = async () => {
		setIsRefreshing(true);
		await refreshAuditLogs(levelFilter);
		setIsRefreshing(false);
	};

	const handleExportCSV = () => {
		const headers = ['ID', 'Action', 'Actor', 'Level', 'Timestamp'];
		const rows = filteredLogs.map((l) => [
			l.id,
			`"${(l.action || '').replace(/"/g, '""')}"`,
			l.actor,
			l.level,
			new Date(l.timestamp).toISOString(),
		]);
		const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
		const encodedUri = encodeURI(csvContent);
		const link = document.createElement('a');
		link.setAttribute('href', encodedUri);
		link.setAttribute('download', `security_audit_trail_${new Date().toISOString().slice(0, 10)}.csv`);
		document.body.appendChild(link);
		link.click();
		link.remove();
	};

	const filteredLogs = auditLogs.filter((log) => {
		const matchesLevel = levelFilter === 'all' || log.level === levelFilter;
		const matchesSearch =
			(log.action || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
			(log.actor || '').toLowerCase().includes(searchTerm.toLowerCase());
		return matchesLevel && matchesSearch;
	});

	return (
		<div className="space-y-6">
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
				<div>
					<h1 className="text-xl font-bold text-slate-900 tracking-tight">Security & Governance Audit Trail</h1>
					<p className="text-xs text-slate-500">
						Persistent cryptographic chronological trail of tenant actions, security alterations, and finance approvals
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-2.5">
					<div className="relative">
						<Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
						<input
							type="text"
							placeholder="Search audit trail..."
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
							className="pl-9 pr-3 py-1.5 rounded-xl bg-white border border-slate-200 text-xs text-slate-900 placeholder:text-slate-400 outline-none focus:border-indigo-500 w-44"
						/>
					</div>

					<select
						value={levelFilter}
						onChange={(e) => {
							setLevelFilter(e.target.value);
							refreshAuditLogs(e.target.value);
						}}
						className="py-1.5 px-3 rounded-xl bg-white border border-slate-200 text-xs text-slate-700 outline-none focus:border-indigo-500">
						<option value="all">All Levels</option>
						<option value="success">Success</option>
						<option value="info">Info</option>
						<option value="warning">Warning</option>
						<option value="danger">Danger / Critical</option>
					</select>

					<button
						type="button"
						onClick={handleRefresh}
						className="py-1.5 px-3 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
						title="Reload Logs">
						<RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
						<span>Sync</span>
					</button>

					<button
						type="button"
						onClick={handleExportCSV}
						className="py-1.5 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs transition-all cursor-pointer">
						<Download size={13} />
						<span>Export CSV</span>
					</button>
				</div>
			</div>

			<div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
				<div className="overflow-x-auto">
					<table className="w-full text-left text-xs">
						<thead>
							<tr className="border-b border-slate-100 bg-slate-50/50 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
								<th className="py-3.5 px-4">Event Description</th>
								<th className="py-3.5 px-4">Actor / System</th>
								<th className="py-3.5 px-4">Level</th>
								<th className="py-3.5 px-4 text-right">Timestamp</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-slate-100 font-medium text-slate-700">
							{filteredLogs.length > 0 ? (
								filteredLogs.map((log) => {
									const isSuccess = log.level === 'success';
									const isDanger = log.level === 'danger';
									const isWarning = log.level === 'warning';
									return (
										<tr key={log.id} className="hover:bg-slate-50/60 transition-colors">
											<td className="py-3 px-4 font-semibold text-slate-900">
												<div className="flex items-center gap-2">
													{isSuccess ? (
														<CheckCircle size={15} className="text-emerald-500 shrink-0" />
													) : isDanger ? (
														<ShieldAlert size={15} className="text-rose-500 shrink-0" />
													) : isWarning ? (
														<AlertTriangle size={15} className="text-amber-500 shrink-0" />
													) : (
														<Info size={15} className="text-indigo-500 shrink-0" />
													)}
													<span>{log.action}</span>
												</div>
											</td>
											<td className="py-3 px-4 text-slate-600 font-mono text-[11px]">{log.actor}</td>
											<td className="py-3 px-4">
												<span
													className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
														isSuccess
															? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
															: isDanger
																? 'bg-rose-50 text-rose-700 border border-rose-200'
																: isWarning
																	? 'bg-amber-50 text-amber-700 border border-amber-200'
																	: 'bg-indigo-50 text-indigo-700 border border-indigo-200'
													}`}>
													{log.level}
												</span>
											</td>
											<td className="py-3 px-4 text-right font-mono text-[11px] text-slate-400">
												{new Date(log.timestamp).toLocaleString()}
											</td>
										</tr>
									);
								})
							) : (
								<tr>
									<td colSpan={4} className="py-10 text-center text-slate-400 text-xs">
										No audit events matching current filter.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}
