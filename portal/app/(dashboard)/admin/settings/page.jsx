'use client';

import React, { useState, useEffect } from 'react';
import { usePortal } from '../../../../context/PortalContext';
import { Save, ShieldCheck, Database, Server, Key, AlertCircle, CheckCircle2 } from 'lucide-react';

export default function SettingsPage() {
	const { platformSettings, savePlatformSettings, showToast } = usePortal();

	const [platformName, setPlatformName] = useState(platformSettings?.platformName || 'SingleSolution Multi-Tenant Cloud');
	const [supportEmail, setSupportEmail] = useState(platformSettings?.supportEmail || 'support@singlesolution.io');
	const [maintenanceMode, setMaintenanceMode] = useState(Boolean(platformSettings?.maintenanceMode));
	const [bankName, setBankName] = useState(platformSettings?.bankDetails?.bankName || '');
	const [accountTitle, setAccountTitle] = useState(platformSettings?.bankDetails?.accountTitle || '');
	const [accountNumber, setAccountNumber] = useState(platformSettings?.bankDetails?.accountNumber || '');
	const [iban, setIban] = useState(platformSettings?.bankDetails?.iban || '');
	const [branch, setBranch] = useState(platformSettings?.bankDetails?.branch || '');
	const [instructions, setInstructions] = useState(platformSettings?.bankDetails?.instructions || '');
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (platformSettings) {
			if (platformSettings.platformName) setPlatformName(platformSettings.platformName);
			if (platformSettings.supportEmail) setSupportEmail(platformSettings.supportEmail);
			setMaintenanceMode(Boolean(platformSettings.maintenanceMode));
			if (platformSettings.bankDetails) {
				setBankName(platformSettings.bankDetails.bankName || '');
				setAccountTitle(platformSettings.bankDetails.accountTitle || '');
				setAccountNumber(platformSettings.bankDetails.accountNumber || '');
				setIban(platformSettings.bankDetails.iban || '');
				setBranch(platformSettings.bankDetails.branch || '');
				setInstructions(platformSettings.bankDetails.instructions || '');
			}
		}
	}, [platformSettings]);

	const handleSave = async (e) => {
		e.preventDefault();
		setIsSaving(true);
		await savePlatformSettings({
			platformName,
			supportEmail,
			maintenanceMode,
			bankDetails: {
				bankName,
				accountTitle,
				accountNumber,
				iban,
				branch,
				instructions,
			},
		});
		setIsSaving(false);
	};

	return (
		<div className="space-y-6 max-w-4xl">
			<div>
				<h1 className="text-xl font-bold text-slate-900 tracking-tight">Cluster & Governance Settings</h1>
				<p className="text-xs text-slate-500">Configure core platform identity, clearing accounts, and security defaults</p>
			</div>

			<form onSubmit={handleSave} className="space-y-6">
				{/* Platform Identity */}
				<div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-4">
					<div className="flex items-center gap-3 pb-3 border-b border-slate-100">
						<div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-xs">
							<Server size={18} />
						</div>
						<div>
							<h3 className="text-xs font-bold text-slate-900">Platform Identity & Operations</h3>
							<p className="text-[11px] text-slate-500">Global metadata displayed to merchant tenants</p>
						</div>
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Platform Brand Title</label>
							<input
								type="text"
								required
								value={platformName}
								onChange={(e) => setPlatformName(e.target.value)}
								className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
							/>
						</div>

						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Master Support Email</label>
							<input
								type="email"
								required
								value={supportEmail}
								onChange={(e) => setSupportEmail(e.target.value)}
								className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
							/>
						</div>
					</div>

					<div className="pt-2 flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-200/60">
						<div>
							<div className="text-xs font-bold text-slate-900">Global Maintenance Mode</div>
							<div className="text-[11px] text-slate-500">
								Block merchant SSO logins for scheduled database maintenance
							</div>
						</div>
						<button
							type="button"
							onClick={() => setMaintenanceMode(!maintenanceMode)}
							className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all cursor-pointer ${
								maintenanceMode ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-700'
							}`}>
							{maintenanceMode ? 'ACTIVE (LOCKED)' : 'DISABLED'}
						</button>
					</div>
				</div>

				{/* Clearing Bank Account */}
				<div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-4">
					<div className="flex items-center gap-3 pb-3 border-b border-slate-100">
						<div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-xs">
							<ShieldCheck size={18} />
						</div>
						<div>
							<h3 className="text-xs font-bold text-slate-900">Wire Clearing Account Details</h3>
							<p className="text-[11px] text-slate-500">
								Displayed to merchants when submitting bank transfer top-up receipts
							</p>
						</div>
					</div>

					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Bank Name</label>
							<input
								type="text"
								value={bankName}
								onChange={(e) => setBankName(e.target.value)}
								className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
							/>
						</div>

						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
								Account Title / Organization
							</label>
							<input
								type="text"
								value={accountTitle}
								onChange={(e) => setAccountTitle(e.target.value)}
								className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
							/>
						</div>

						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Account Number</label>
							<input
								type="text"
								value={accountNumber}
								onChange={(e) => setAccountNumber(e.target.value)}
								className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-[11px] outline-none focus:border-indigo-500"
							/>
						</div>

						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">IBAN (International)</label>
							<input
								type="text"
								value={iban}
								onChange={(e) => setIban(e.target.value)}
								className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-[11px] outline-none focus:border-indigo-500"
							/>
						</div>

						<div className="sm:col-span-2">
							<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Branch Details</label>
							<input
								type="text"
								value={branch}
								onChange={(e) => setBranch(e.target.value)}
								className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
							/>
						</div>

						<div className="sm:col-span-2">
							<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Payment Instructions</label>
							<textarea
								rows={2}
								value={instructions}
								onChange={(e) => setInstructions(e.target.value)}
								className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500 resize-none"
							/>
						</div>
					</div>
				</div>

				{/* Database Cluster Status */}
				<div className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-3 text-xs">
					<div className="flex items-center gap-3 pb-3 border-b border-slate-100">
						<div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold text-xs">
							<Database size={18} />
						</div>
						<div>
							<h3 className="text-xs font-bold text-slate-900">MongoDB Core Connection Pool</h3>
							<p className="text-[11px] text-slate-500">Active persistence pool: portal_core database</p>
						</div>
					</div>
					<div className="flex items-center justify-between text-slate-600">
						<span>Connection Protocol:</span>
						<span className="font-bold font-mono text-slate-900">mongodb://localhost:27017/portal_core</span>
					</div>
					<div className="flex items-center justify-between text-slate-600">
						<span>Persistence Status:</span>
						<span className="inline-flex items-center gap-1 font-bold text-emerald-600">
							<CheckCircle2 size={13} />
							<span>Active & Synced</span>
						</span>
					</div>
				</div>

				<button
					type="submit"
					disabled={isSaving}
					className="py-2.5 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-2 shadow-xs transition-all cursor-pointer disabled:opacity-50">
					<Save size={14} />
					<span>{isSaving ? 'Saving to Database...' : 'Save Platform Settings'}</span>
				</button>
			</form>
		</div>
	);
}
