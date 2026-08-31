'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { usePortal } from '../context/PortalContext';
import { Search, Store, Grid, Shield, X, ArrowRight } from 'lucide-react';

export default function GlobalSearchModal({ isOpen, onClose }) {
	const router = useRouter();
	const { products = [], tenants = [], role, launchMicroApp } = usePortal();
	const [query, setQuery] = useState('');

	if (!isOpen) return null;

	const cleanQuery = query.toLowerCase().trim();

	const matchedApps = products.filter(
		(p) =>
			p.name.toLowerCase().includes(cleanQuery) ||
			p.id.toLowerCase().includes(cleanQuery) ||
			p.category.toLowerCase().includes(cleanQuery),
	);

	const matchedTenants =
		role === 'admin'
			? tenants.filter(
					(t) =>
						t.name.toLowerCase().includes(cleanQuery) ||
						t.domain.toLowerCase().includes(cleanQuery) ||
						t.id.toLowerCase().includes(cleanQuery),
				)
			: [];

	const handleNavigate = (path) => {
		router.push(path);
		onClose();
	};

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-20 p-4 bg-slate-900/60 backdrop-blur-sm animate-fade-in">
			<div className="w-full max-w-xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden animate-slide-down">
				{/* Search Input Bar */}
				<div className="flex items-center px-4 py-3.5 border-b border-slate-100 gap-3">
					<Search size={18} className="text-slate-400 shrink-0" />
					<input
						type="text"
						autoFocus
						placeholder="Search applications, stores, settings or commands..."
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="flex-1 text-sm bg-transparent outline-none placeholder:text-slate-400 text-slate-900 font-medium"
					/>
					<button
						onClick={onClose}
						className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
						<X size={16} />
					</button>
				</div>

				{/* Results Body */}
				<div className="max-h-[60vh] overflow-y-auto p-3 space-y-4">
					{/* Apps Section */}
					<div>
						<div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 px-3 py-1.5 flex items-center gap-2">
							<Grid size={12} />
							<span>SaaS Micro-Applications</span>
						</div>
						<div className="space-y-1 mt-1">
							{matchedApps.length > 0 ? (
								matchedApps.map((app) => (
									<button
										key={app.id}
										onClick={() => {
											launchMicroApp(app);
											onClose();
										}}
										className="w-full px-3 py-2 rounded-xl flex items-center justify-between hover:bg-slate-50 transition-colors text-left group">
										<div className="flex items-center gap-3">
											<div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-xs">
												{app.name.charAt(0)}
											</div>
											<div>
												<div className="text-xs font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">
													{app.name}
												</div>
												<div className="text-[11px] text-slate-400">
													{app.category} · {app.url}
												</div>
											</div>
										</div>
										<span className="text-[11px] font-semibold text-slate-400 group-hover:text-indigo-600 flex items-center gap-1">
											Launch SSO <ArrowRight size={12} />
										</span>
									</button>
								))
							) : (
								<p className="text-xs text-slate-400 px-3 py-1">No apps found</p>
							)}
						</div>
					</div>

					{/* Tenants Section (Admin only) */}
					{role === 'admin' && (
						<div>
							<div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 px-3 py-1.5 flex items-center gap-2">
								<Store size={12} />
								<span>Merchant Stores</span>
							</div>
							<div className="space-y-1 mt-1">
								{matchedTenants.length > 0 ? (
									matchedTenants.map((tenant) => (
										<button
											key={tenant.id}
											onClick={() => handleNavigate('/admin/tenants')}
											className="w-full px-3 py-2 rounded-xl flex items-center justify-between hover:bg-slate-50 transition-colors text-left group">
											<div>
												<div className="text-xs font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">
													{tenant.name}
												</div>
												<div className="text-[11px] text-slate-400">
													{tenant.domain} · {tenant.plan}
												</div>
											</div>
											<span className="text-[11px] font-semibold text-slate-400 group-hover:text-indigo-600 flex items-center gap-1">
												Manage <ArrowRight size={12} />
											</span>
										</button>
									))
								) : (
									<p className="text-xs text-slate-400 px-3 py-1">No merchants found</p>
								)}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
