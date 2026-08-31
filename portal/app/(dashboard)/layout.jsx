'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePortal } from '../../context/PortalContext';
import PortalSidebar from '../../components/PortalSidebar';
import PortalHeader from '../../components/PortalHeader';
import GlobalSearchModal from '../../components/GlobalSearchModal';
import { Zap } from 'lucide-react';

export default function DashboardLayout({ children }) {
	const router = useRouter();
	const [mounted, setMounted] = useState(false);
	const [isSearchOpen, setIsSearchOpen] = useState(false);
	const { isAuthenticated, isLoading } = usePortal();

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (mounted && !isLoading && !isAuthenticated) {
			router.replace('/login');
		}
	}, [mounted, isLoading, isAuthenticated, router]);

	// Keyboard shortcut for Cmd+K
	useEffect(() => {
		const handleKeyDown = (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
				e.preventDefault();
				setIsSearchOpen((prev) => !prev);
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, []);

	if (!mounted || isLoading) {
		return (
			<div className="min-h-screen bg-slate-50/80 flex flex-col items-center justify-center space-y-4">
				<div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg shadow-indigo-200 animate-pulse">
					<Zap size={20} />
				</div>
				<div className="text-xs font-bold text-slate-400">Verifying session security...</div>
			</div>
		);
	}

	if (!isAuthenticated) {
		return null;
	}

	return (
		<div className="min-h-screen bg-slate-50/70 flex flex-col md:flex-row antialiased text-slate-900 font-sans">
			{/* Left Sidebar */}
			<PortalSidebar />

			{/* Main Content Area */}
			<div className="flex-1 flex flex-col min-w-0">
				<PortalHeader onOpenSearch={() => setIsSearchOpen(true)} />
				<main className="flex-1 p-6 md:p-8 space-y-6 max-w-7xl w-full mx-auto">{children}</main>
			</div>

			{/* Global Search Modal */}
			<GlobalSearchModal isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
		</div>
	);
}
