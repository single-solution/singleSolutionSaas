'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePortal } from '../context/PortalContext';
import { Zap } from 'lucide-react';

export default function RootPage() {
	const router = useRouter();
	const [mounted, setMounted] = useState(false);
	const { hasAdmin, isAuthenticated, role, isLoading } = usePortal();

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (mounted && !isLoading) {
			if (!hasAdmin) {
				router.replace('/setup');
			} else if (!isAuthenticated) {
				router.replace('/login');
			} else {
				router.replace(role === 'merchant' ? '/merchant/home' : '/admin');
			}
		}
	}, [mounted, hasAdmin, isAuthenticated, role, isLoading, router]);

	return (
		<div className="min-h-screen bg-slate-50/80 flex flex-col items-center justify-center space-y-4">
			<div className="w-12 h-12 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg shadow-indigo-200 animate-pulse">
				<Zap size={24} />
			</div>
			<div className="text-xs font-bold text-slate-500">Initializing SingleSolution Cluster...</div>
		</div>
	);
}
