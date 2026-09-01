'use client';

import React, { useState } from 'react';
import { usePortal } from '../../../../context/PortalContext';
import ConfirmModal from '../../../../components/ConfirmModal';
import {
	Plus,
	Globe,
	Trash2,
	Edit3,
	Key,
	CheckCircle,
	Sliders,
	ExternalLink,
	Activity,
	Layers,
	RefreshCw,
	CheckCircle2,
	XCircle,
	Coins,
	DollarSign,
} from 'lucide-react';

export default function AppRegistryTable() {
	const { products = [], registerProduct, deleteProduct, checkAppHealth, launchMicroApp, activeTenant } = usePortal();

	const [isRegisterOpen, setIsRegisterOpen] = useState(false);
	const [editingProduct, setEditingProduct] = useState(null);
	const [healthMap, setHealthMap] = useState({});
	const [isProbing, setIsProbing] = useState(false);

	const [newName, setNewName] = useState('');
	const [newUrl, setNewUrl] = useState('');
	const [newSecretKey, setNewSecretKey] = useState('');
	const [newDesc, setNewDesc] = useState('');

	// Confirm Deletion State
	const [deleteConfirmProduct, setDeleteConfirmProduct] = useState(null);

	const handleProbeAll = async () => {
		setIsProbing(true);
		const results = {};
		for (const prod of products) {
			const res = await checkAppHealth(prod.url);
			results[prod.id] = res;
		}
		setHealthMap(results);
		setIsProbing(false);
	};

	const handleCreateProduct = async (e) => {
		e.preventDefault();
		const result = await registerProduct({
			name: newName,
			url: newUrl,
			secretKey: newSecretKey,
			desc: newDesc,
		});
		if (result) {
			setNewName('');
			setNewUrl('');
			setNewSecretKey('');
			setNewDesc('');
			setIsRegisterOpen(false);
		}
	};

	const handleSaveEditProduct = async (e) => {
		e.preventDefault();
		if (!editingProduct) return;
		const result = await registerProduct(editingProduct);
		if (result) {
			setEditingProduct(null);
		}
	};

	return (
		<div className="space-y-6">
			{/* Top Actions */}
			<div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
				<div>
					<h1 className="text-xl font-bold text-slate-900 tracking-tight">Micro-App Ecosystem Registry</h1>
					<p className="text-xs text-slate-500">
						Deploy micro-frontends, manage HMAC cryptographic secrets, and monitor ecosystem health
					</p>
				</div>
				<div className="flex items-center gap-2.5">
					<button
						type="button"
						onClick={handleProbeAll}
						disabled={isProbing}
						className="py-1.5 px-3.5 rounded-xl bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50">
						<RefreshCw size={13} className={isProbing ? 'animate-spin' : ''} />
						<span>{isProbing ? 'Probing Nodes...' : 'Probe Cluster Health'}</span>
					</button>

					<button
						type="button"
						onClick={() => setIsRegisterOpen(true)}
						className="py-1.5 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs transition-all cursor-pointer">
						<Plus size={14} />
						<span>Register Micro-App</span>
					</button>
				</div>
			</div>

			{/* Micro-App Cards Grid */}
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{products.map((product) => {
					const health = healthMap[product.id];
					const totalAppFloat = (product.features || []).reduce((sum, f) => sum + (f.creditCost || 0), 0);

					return (
						<div
							key={product.id}
							className="p-5 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex flex-col justify-between space-y-4 hover:shadow-md transition-all group">
							<div className="space-y-3">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-3">
										<div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold text-base shadow-2xs group-hover:scale-105 transition-transform">
											<Layers size={20} />
										</div>
										<div>
											<div className="flex items-center gap-1.5">
												<h3 className="font-bold text-sm text-slate-900">{product.name}</h3>
											</div>
										</div>
									</div>

									{health ? (
										<span
											className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
												health.online
													? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
													: 'bg-rose-50 text-rose-700 border border-rose-200'
											}`}>
											{health.online ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
											<span>{health.online ? 'Online' : 'Offline'}</span>
										</span>
									) : (
										<span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
											{product.status || 'Active'}
										</span>
									)}
								</div>

								<p className="text-xs text-slate-500 line-clamp-2">{product.desc || product.description}</p>

								{/* Feature Summary */}
								<div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100 text-xs flex items-center justify-between">
									<div>
										<span className="font-bold text-slate-900">{product.features?.length || 0} Features</span>
										<span className="text-[10px] text-slate-400 block">Catalog Capabilities</span>
									</div>
									<div className="text-right">
										<span className="font-extrabold text-indigo-600">${totalAppFloat} credits</span>
										<span className="text-[10px] text-slate-400 block">Full suite / mo</span>
									</div>
								</div>

								<div className="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono text-slate-400">
									<span>Endpoint:</span>
									<a
										href={product.url}
										target="_blank"
										rel="noopener noreferrer"
										className="text-indigo-600 hover:underline flex items-center gap-1 font-semibold">
										<span>{product.url}</span>
										<ExternalLink size={10} />
									</a>
								</div>
							</div>

							<div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
								<div className="flex items-center gap-1">
									<button
										type="button"
										onClick={() => setEditingProduct(product)}
										className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors cursor-pointer"
										title="Edit App Configuration">
										<Edit3 size={14} />
									</button>
									<button
										type="button"
										onClick={() => setDeleteConfirmProduct(product)}
										className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
										title="Delete Micro-App">
										<Trash2 size={16} />
									</button>
								</div>

								<button
									type="button"
									onClick={() => launchMicroApp(product, activeTenant)}
									className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-xs transition-all cursor-pointer">
									<span>Launch App</span>
									<ExternalLink size={12} />
								</button>
							</div>
						</div>
					);
				})}
			</div>

			{/* Edit App Modal */}
			{editingProduct && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<h3 className="text-sm font-bold text-slate-900">Configure Micro-App</h3>
							<button onClick={() => setEditingProduct(null)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						<form onSubmit={handleSaveEditProduct} className="space-y-4 text-xs">
							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">App Name</label>
								<input
									type="text"
									required
									value={editingProduct.name}
									onChange={(e) => setEditingProduct({ ...editingProduct, name: e.target.value })}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Base Endpoint URL</label>
								<input
									type="text"
									required
									value={editingProduct.url}
									onChange={(e) => setEditingProduct({ ...editingProduct, url: e.target.value })}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-[11px] outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">SSO Secret Key</label>
								<input
									type="text"
									required
									placeholder="Shared secret for SSO handshakes"
									value={editingProduct.secretKey || ''}
									onChange={(e) => setEditingProduct({ ...editingProduct, secretKey: e.target.value })}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-[11px] outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Description</label>
								<textarea
									rows={2}
									value={editingProduct.desc || editingProduct.description || ''}
									onChange={(e) =>
										setEditingProduct({ ...editingProduct, desc: e.target.value, description: e.target.value })
									}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500 resize-none"
								/>
							</div>

							<div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
								<button
									type="button"
									onClick={() => setEditingProduct(null)}
									className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold">
									Cancel
								</button>
								<button
									type="submit"
									className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-xs">
									Save Micro-App
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			{/* Register App Modal */}
			{isRegisterOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-lg bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<h3 className="text-sm font-bold text-slate-900">Register New Micro-App</h3>
							<button onClick={() => setIsRegisterOpen(false)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						<form onSubmit={handleCreateProduct} className="space-y-4 text-xs">
							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">App Title</label>
								<input
									type="text"
									required
									placeholder="e.g. Smart Inventory Sync"
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Base Endpoint URL</label>
								<input
									type="text"
									required
									placeholder="http://localhost:5006"
									value={newUrl}
									onChange={(e) => setNewUrl(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-[11px] outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">SSO Secret Key</label>
								<input
									type="text"
									required
									placeholder="Shared secret for SSO handshakes"
									value={newSecretKey}
									onChange={(e) => setNewSecretKey(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-mono text-[11px] outline-none focus:border-indigo-500"
								/>
							</div>

							<div>
								<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">Description</label>
								<textarea
									rows={2}
									placeholder="Brief description of capabilities..."
									value={newDesc}
									onChange={(e) => setNewDesc(e.target.value)}
									className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500 resize-none"
								/>
							</div>

							<div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
								<button
									type="button"
									onClick={() => setIsRegisterOpen(false)}
									className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold">
									Cancel
								</button>
								<button
									type="submit"
									className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-xs">
									Register App
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
			{/* Delete Confirmation Modal */}
			<ConfirmModal
				isOpen={!!deleteConfirmProduct}
				onClose={() => setDeleteConfirmProduct(null)}
				onConfirm={() => deleteProduct(deleteConfirmProduct.id)}
				title="Delete Micro-App"
				message={`Are you sure you want to completely remove ${deleteConfirmProduct?.name} from the cluster registry? This will instantly disable it for all merchants.`}
				confirmText="Yes, delete it"
				confirmStyle="danger"
			/>
		</div>
	);
}
