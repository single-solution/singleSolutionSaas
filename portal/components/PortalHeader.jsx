'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { usePortal } from '../context/PortalContext';
import { Search, Shield, Store, LogOut, Coins } from 'lucide-react';

export default function PortalHeader({ onOpenSearch }) {
	const router = useRouter();
	const { currentUser, role, activeTenant, logout } = usePortal();

	const handleLogout = async () => {
		await logout();
		router.replace('/login');
	};

	return (
		<header className="h-16 px-6 bg-white/90 backdrop-blur-md border-b border-slate-200/80 flex items-center justify-between sticky top-0 z-30 transition-all">
			{/* Left: Quick Search */}
			<div className="flex items-center gap-4">
				<button
					type="button"
					onClick={onOpenSearch}
					className="flex items-center gap-3 px-3.5 py-1.5 rounded-xl bg-slate-100/80 hover:bg-slate-100 text-slate-400 hover:text-slate-600 text-xs font-medium border border-slate-200/60 transition-all w-64 text-left group cursor-pointer">
					<Search size={14} className="group-hover:text-indigo-600 transition-colors" />
					<span className="flex-1">Search portal...</span>
					<kbd className="px-1.5 py-0.5 text-[10px] font-bold bg-white text-slate-500 rounded border border-slate-200 shadow-2xs">
						⌘K
					</kbd>
				</button>
			</div>

			{/* Right: User identity & Controls */}
			<div className="flex items-center gap-3">
				{/* Merchant Balance (When logged in as Merchant) */}
				{role === 'merchant' && activeTenant && (
					<div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200/60 text-xs font-bold text-amber-900">
						<Coins size={14} className="text-amber-600" />
						<span>${activeTenant.creditsBalance || 0}</span>
						<span className="text-[10px] text-amber-600 font-normal uppercase">Float</span>
					</div>
				)}

				{/* Role Badge */}
				<div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-slate-100 border border-slate-200/80 text-xs font-bold">
					{role === 'admin' ? (
						<>
							<Shield size={13} className="text-indigo-600" />
							<span className="text-indigo-950 font-extrabold">SuperAdmin</span>
						</>
					) : (
						<>
							<Store size={13} className="text-emerald-600" />
							<span className="text-emerald-950 font-extrabold">{currentUser?.name || 'Merchant Store'}</span>
						</>
					)}
				</div>

				{/* User Avatar & Logout */}
				<div className="flex items-center gap-2 pl-2 border-l border-slate-200">
					<div className="w-8 h-8 rounded-xl bg-indigo-600 text-white font-extrabold text-xs flex items-center justify-center shadow-xs">
						{currentUser?.name ? currentUser.name.charAt(0).toUpperCase() : 'U'}
					</div>
					<button
						type="button"
						onClick={handleLogout}
						title="Sign Out"
						className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-colors cursor-pointer">
						<LogOut size={16} />
					</button>
				</div>
			</div>
		</header>
	);
}
