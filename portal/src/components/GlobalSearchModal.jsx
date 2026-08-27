import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
	Search,
	Users,
	Grid,
	Coins,
	Settings,
	Shield,
	LayoutDashboard,
	Store,
	Key,
	ExternalLink,
	ArrowRight,
	Plus,
	LogOut,
	Sparkles,
	Clock,
} from 'lucide-react';
import { usePortal } from '../context/PortalContext';

export default function GlobalSearchModal({ isOpen, onClose }) {
	const navigate = useNavigate();
	const { role, tenants, products, depositRequests, creditTransactions, logout } = usePortal();
	const [query, setQuery] = useState('');
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef(null);
	const listRef = useRef(null);

	useEffect(() => {
		if (isOpen) {
			setQuery('');
			setSelectedIndex(0);
			setTimeout(() => inputRef.current?.focus(), 50);
		}
	}, [isOpen]);

	const items = [];

	// 1. Navigation Pages
	if (role === 'admin') {
		items.push(
			{
				id: 'nav-dashboard',
				category: 'Navigation',
				title: 'Dashboard',
				subtitle: 'Overview, credit totals, and KPI metrics',
				icon: LayoutDashboard,
				path: '/',
			},
			{
				id: 'nav-merchants',
				category: 'Navigation',
				title: 'Merchants',
				subtitle: 'Manage merchant accounts, credentials, and wallet credits',
				icon: Users,
				path: '/tenants',
			},
			{
				id: 'nav-products',
				category: 'Navigation',
				title: 'Product Management',
				subtitle: 'SaaS micro-apps and product registry',
				icon: Grid,
				path: '/registry',
			},
			{
				id: 'nav-billing',
				category: 'Navigation',
				title: 'Credits & Subscriptions',
				subtitle: 'Bank transfer approvals, merchant wallets, and ledger',
				icon: Coins,
				path: '/billing',
			},
			{
				id: 'nav-audit',
				category: 'Navigation',
				title: 'Audit Logs',
				subtitle: 'Security and administrative audit trail',
				icon: Shield,
				path: '/audit-logs',
			},
			{
				id: 'nav-settings',
				category: 'Navigation',
				title: 'Settings',
				subtitle: 'Rate limits, timeouts, and configuration',
				icon: Settings,
				path: '/settings',
			},
			{
				id: 'nav-landing',
				category: 'Navigation',
				title: 'Product Showcase',
				subtitle: 'Public product showcase and features',
				icon: Sparkles,
				path: '/landing',
			},
		);
	} else {
		items.push(
			{
				id: 'nav-m-home',
				category: 'Navigation',
				title: 'Overview',
				subtitle: 'Store overview and active products',
				icon: Store,
				path: '/merchant',
			},
			{
				id: 'nav-m-products',
				category: 'Navigation',
				title: 'Products',
				subtitle: 'Enable modular apps and tools',
				icon: Grid,
				path: '/merchant/licenses',
			},
			{
				id: 'nav-m-keys',
				category: 'Navigation',
				title: 'API Keys',
				subtitle: 'Developer credentials and webhooks',
				icon: Key,
				path: '/merchant/credentials',
			},
			{
				id: 'nav-m-billing',
				category: 'Navigation',
				title: 'Wallet & Top Up',
				subtitle: 'Bank transfer top-up, credits, and ledger',
				icon: Coins,
				path: '/merchant/billing',
			},
			{
				id: 'nav-landing',
				category: 'Navigation',
				title: 'Product Showcase',
				subtitle: 'Public product showcase',
				icon: Sparkles,
				path: '/landing',
			},
		);
	}

	// 2. Real Registered Merchants
	tenants.forEach((tenant) => {
		items.push({
			id: `tenant-${tenant.id}`,
			category: 'Merchants',
			title: tenant.name,
			subtitle: `${tenant.domain} • $${tenant.creditsBalance || 0} credits • ${tenant.plan.toUpperCase()} Plan`,
			icon: Store,
			badge: tenant.status.toUpperCase(),
			path: '/tenants',
		});
	});

	// 3. Products
	products.forEach((prod) => {
		items.push({
			id: `prod-${prod.id}`,
			category: 'Products',
			title: prod.name,
			subtitle: `SaaS Product • $${prod.price}/mo`,
			icon: Grid,
			path: role === 'admin' ? '/registry' : '/merchant/licenses',
			externalUrl: prod.url || `http://localhost:${prod.port}`,
		});
	});

	// 4. Bank Deposit Requests
	depositRequests.forEach((req) => {
		items.push({
			id: `dep-${req.id}`,
			category: 'Bank Deposits',
			title: `${req.id} - $${req.amount}.00`,
			subtitle: `${req.tenantName} • Ref: ${req.transactionRef} • ${req.status.toUpperCase()}`,
			icon: Clock,
			path: role === 'admin' ? '/billing' : '/merchant/billing',
		});
	});

	// 5. Credit Transactions
	creditTransactions.forEach((tx) => {
		items.push({
			id: `tx-${tx.id}`,
			category: 'Transactions',
			title: `${tx.id} - ${tx.type === 'deposit' ? '+' : '-'}$${tx.amount}.00`,
			subtitle: `${tx.tenantName} • ${tx.method} • ${tx.reference}`,
			icon: Coins,
			path: role === 'admin' ? '/billing' : '/merchant/billing',
		});
	});

	// 6. Quick Actions
	if (role === 'admin') {
		items.push(
			{
				id: 'act-add-tenant',
				category: 'Quick Actions',
				title: 'Add New Merchant',
				subtitle: 'Create a new storefront account',
				icon: Plus,
				path: '/tenants',
			},
			{
				id: 'act-topup',
				category: 'Quick Actions',
				title: 'Manage Credits & Deposits',
				subtitle: 'Review bank wire top-up requests',
				icon: Coins,
				path: '/billing',
			},
		);
	}
	items.push({
		id: 'act-logout',
		category: 'Quick Actions',
		title: 'Sign Out',
		subtitle: 'End current platform session',
		icon: LogOut,
		action: () => {
			logout();
			onClose();
		},
	});

	// Filter by search query
	const filtered = query.trim()
		? items.filter(
				(item) =>
					item.title.toLowerCase().includes(query.toLowerCase()) ||
					item.subtitle.toLowerCase().includes(query.toLowerCase()) ||
					item.category.toLowerCase().includes(query.toLowerCase()),
			)
		: items;

	// Handle selection
	const handleSelect = (item) => {
		onClose();
		if (item.action) {
			item.action();
		} else if (item.path) {
			navigate(item.path);
		}
	};

	// Keyboard navigation
	const handleKeyDown = (e) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setSelectedIndex((prev) => (prev + 1 < filtered.length ? prev + 1 : 0));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setSelectedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : filtered.length - 1));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (filtered[selectedIndex]) {
				handleSelect(filtered[selectedIndex]);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	};

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-20 p-4 bg-slate-900/40">
			<div className="fixed inset-0" onClick={onClose} />

			<div className="relative w-full max-w-xl bg-white rounded-3xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col z-10 antialiased font-sans">
				{/* Search Input Bar */}
				<div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-200 bg-white">
					<Search size={18} className="text-slate-400 shrink-0" />
					<input
						ref={inputRef}
						type="text"
						placeholder="Search pages, merchants, products, bank deposits, or actions..."
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setSelectedIndex(0);
						}}
						onKeyDown={handleKeyDown}
						className="w-full text-sm text-slate-900 placeholder-slate-400 bg-transparent focus:outline-none"
					/>
					<kbd className="px-2 py-0.5 text-[10px] font-mono bg-slate-100 border border-slate-200 rounded-lg text-slate-500 shrink-0">
						ESC
					</kbd>
				</div>

				{/* Results List */}
				<div ref={listRef} className="max-h-[380px] overflow-y-auto p-2 space-y-1 divide-y divide-slate-50">
					{filtered.length === 0 ? (
						<div className="py-12 text-center text-xs text-slate-500 space-y-1">
							<p className="font-semibold text-slate-700">No results found for &ldquo;{query}&rdquo;</p>
							<p className="text-slate-400">Try searching for a merchant name, page title, or bank deposit.</p>
						</div>
					) : (
						filtered.map((item, idx) => {
							const IconComp = item.icon;
							const isSelected = idx === selectedIndex;

							return (
								<button
									type="button"
									key={item.id}
									onClick={() => handleSelect(item)}
									onMouseEnter={() => setSelectedIndex(idx)}
									className={`w-full flex items-center justify-between p-2.5 rounded-2xl text-left transition-all duration-150 cursor-pointer ${
										isSelected ? 'bg-indigo-600 text-white shadow-xs' : 'hover:bg-slate-100 text-slate-800'
									}`}>
									<div className="flex items-center gap-3 min-w-0">
										<div
											className={`p-2 rounded-xl shrink-0 ${
												isSelected
													? 'bg-indigo-700 text-white'
													: 'bg-slate-100 text-slate-700 border border-slate-200'
											}`}>
											<IconComp size={15} />
										</div>
										<div className="min-w-0">
											<div className="flex items-center gap-2">
												<span className="font-semibold text-xs truncate">{item.title}</span>
												<span
													className={`text-[10px] px-1.5 py-0.2 rounded-full font-medium ${
														isSelected
															? 'bg-indigo-500 text-indigo-100'
															: 'bg-slate-100 text-slate-600 border border-slate-200'
													}`}>
													{item.category}
												</span>
											</div>
											<div
												className={`text-[11px] truncate mt-0.5 ${isSelected ? 'text-indigo-200' : 'text-slate-500'}`}>
												{item.subtitle}
											</div>
										</div>
									</div>

									<div className="flex items-center gap-1 shrink-0 pl-2">
										{item.externalUrl && (
											<a
												href={item.externalUrl}
												target="_blank"
												rel="noopener noreferrer"
												onClick={(e) => e.stopPropagation()}
												className={`p-1 rounded hover:bg-indigo-500 ${isSelected ? 'text-indigo-200' : 'text-slate-500'}`}
												title="Open in new window">
												<ExternalLink size={12} />
											</a>
										)}
										<ArrowRight size={13} className={isSelected ? 'text-white' : 'text-slate-300'} />
									</div>
								</button>
							);
						})
					)}
				</div>

				{/* Footer Quick Keys */}
				<div className="px-4 py-2 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-[11px] text-slate-500">
					<div className="flex items-center gap-3">
						<span>
							<kbd className="px-1 py-0.5 font-mono bg-white border border-slate-200 rounded text-slate-600 text-[10px]">
								↑
							</kbd>{' '}
							<kbd className="px-1 py-0.5 font-mono bg-white border border-slate-200 rounded text-slate-600 text-[10px]">
								↓
							</kbd>{' '}
							navigate
						</span>
						<span>
							<kbd className="px-1 py-0.5 font-mono bg-white border border-slate-200 rounded text-slate-600 text-[10px]">
								↵
							</kbd>{' '}
							select
						</span>
					</div>
					<span>
						<kbd className="px-1 py-0.5 font-mono bg-white border border-slate-200 rounded text-slate-600 text-[10px]">
							esc
						</kbd>{' '}
						close
					</span>
				</div>
			</div>
		</div>
	);
}
