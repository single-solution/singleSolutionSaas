'use client';

import React, { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { usePortal } from '../../context/PortalContext';
import {
	Lock,
	Mail,
	ShieldCheck,
	Store,
	ArrowRight,
	AlertCircle,
	Zap,
	ShieldAlert,
	Eye,
	EyeOff,
	HelpCircle,
	CheckCircle,
	X,
	Terminal,
} from 'lucide-react';

function LoginForm() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const callbackUrl = searchParams?.get('callbackUrl') || '';

	const { login, hasAdmin, isLoading, showToast } = usePortal();

	const [role, setRole] = useState('admin'); // 'admin' | 'merchant'
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [showPassword, setShowPassword] = useState(false);
	const [rememberMe, setRememberMe] = useState(true);
	const [error, setError] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Forgot Password Modal State
	const [isForgotOpen, setIsForgotOpen] = useState(false);
	const [forgotEmail, setForgotEmail] = useState('');
	const [forgotLoading, setForgotLoading] = useState(false);
	const [forgotResult, setForgotResult] = useState(null);

	const handleLogin = async (e) => {
		e.preventDefault();
		setError('');
		setIsSubmitting(true);

		try {
			const sessionUser = await login(email, password, role);
			if (callbackUrl && callbackUrl.startsWith('/')) {
				router.replace(callbackUrl);
			} else if (sessionUser?.role === 'merchant') {
				router.replace('/merchant/home');
			} else {
				router.replace('/admin');
			}
		} catch (err) {
			setError(err.message || 'Invalid credentials.');
			setIsSubmitting(false);
		}
	};

	const handleForgotPassword = async (e) => {
		e.preventDefault();
		if (!forgotEmail) return;
		setForgotLoading(true);

		try {
			const res = await fetch('/api/auth/forgot-password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: forgotEmail, role }),
			});
			const data = await res.json();
			setForgotResult(data);
		} catch (err) {
			showToast(err.message || 'Recovery request failed', 'danger');
		} finally {
			setForgotLoading(false);
		}
	};

	return (
		<div className="w-full max-w-md space-y-6">
			{/* Brand Header */}
			<div className="text-center space-y-2">
				<div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-600 text-white shadow-md shadow-indigo-100 mb-1 transition-transform hover:scale-105">
					<Zap size={24} />
				</div>
				<h1 className="text-2xl font-bold tracking-tight text-slate-900">
					{role === 'admin' ? 'SuperAdmin Control Console' : 'Merchant Storefront Portal'}
				</h1>
				<p className="text-xs text-slate-500 max-w-sm mx-auto">
					{role === 'admin'
						? 'Sign in with your master credentials to govern the SaaS cluster.'
						: 'Sign in with your store administrator email or domain.'}
				</p>
			</div>

			{/* Card Container */}
			<div className="p-8 rounded-2xl bg-white border border-slate-200/80 shadow-md space-y-6">
				{/* No Admin Notice */}
				{!isLoading && !hasAdmin && (
					<div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs space-y-2">
						<div className="flex items-center gap-2 font-bold text-amber-800">
							<ShieldAlert size={16} className="text-amber-600 shrink-0" />
							<span>Platform Initialization Required</span>
						</div>
						<p className="text-[11px] leading-relaxed">
							No master SuperAdmin account exists in the database. Please run the setup wizard to create the root
							administrator.
						</p>
						<Link
							href="/setup"
							className="inline-flex items-center gap-1.5 font-bold text-indigo-600 hover:text-indigo-800 underline mt-1">
							<span>Initialize SuperAdmin Setup</span>
							<ArrowRight size={12} />
						</Link>
					</div>
				)}

				{/* Role Switcher Tabs */}
				<div className="grid grid-cols-2 gap-1 p-1 bg-slate-100/80 border border-slate-200/80 rounded-xl">
					<button
						type="button"
						onClick={() => {
							setRole('admin');
							setError('');
						}}
						className={`py-2 text-xs font-bold rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer ${
							role === 'admin' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
						}`}>
						<ShieldCheck size={14} />
						<span>SuperAdmin</span>
					</button>
					<button
						type="button"
						onClick={() => {
							setRole('merchant');
							setError('');
						}}
						className={`py-2 text-xs font-bold rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer ${
							role === 'merchant' ? 'bg-white text-indigo-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
						}`}>
						<Store size={14} />
						<span>Merchant</span>
					</button>
				</div>

				{/* Error Alert */}
				{error && (
					<div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
						<AlertCircle size={15} className="shrink-0" />
						<span>{error}</span>
					</div>
				)}

				{/* Form */}
				<form onSubmit={handleLogin} className="space-y-4">
					<div>
						<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
							{role === 'admin' ? 'SuperAdmin Email' : 'Store Email or Domain'}
						</label>
						<div className="relative">
							<Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
							<input
								type="text"
								required
								placeholder={role === 'admin' ? 'admin@singlesolution.io' : 'owner@yourstore.com'}
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								disabled={isSubmitting}
								className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
							/>
						</div>
					</div>

					<div>
						<div className="flex items-center justify-between mb-1.5">
							<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider">
								{role === 'admin' ? 'Password' : 'Store Password or Secret Key'}
							</label>
							<button
								type="button"
								onClick={() => {
									setForgotEmail(email);
									setForgotResult(null);
									setIsForgotOpen(true);
								}}
								className="text-[11px] text-indigo-600 hover:text-indigo-800 font-semibold cursor-pointer">
								Forgot Password?
							</button>
						</div>
						<div className="relative flex items-center">
							<Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
							<input
								type={showPassword ? 'text' : 'password'}
								required
								placeholder="••••••••••••"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								disabled={isSubmitting}
								className="w-full pl-10 pr-10 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
							/>
							<button
								type="button"
								onClick={() => setShowPassword(!showPassword)}
								className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
								title={showPassword ? 'Hide password' : 'Show password'}>
								{showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
							</button>
						</div>
					</div>

					<div className="flex items-center justify-between pt-1">
						<label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
							<input
								type="checkbox"
								checked={rememberMe}
								onChange={(e) => setRememberMe(e.target.checked)}
								className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
							/>
							<span>Remember session</span>
						</label>
					</div>

					<button
						type="submit"
						disabled={isSubmitting}
						className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-xs active:scale-[0.99] transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xs hover:shadow-sm disabled:opacity-50">
						<span>
							{isSubmitting
								? 'Authenticating...'
								: role === 'admin'
									? 'Access SuperAdmin Console'
									: 'Sign In to Merchant Hub'}
						</span>
						<ArrowRight size={14} />
					</button>
				</form>

				{!isLoading && !hasAdmin && (
					<div className="pt-3 border-t border-slate-100 text-center">
						<Link
							href="/setup"
							className="text-xs text-indigo-600 hover:text-indigo-700 underline cursor-pointer transition-colors font-medium">
							Configure Root SuperAdmin Account →
						</Link>
					</div>
				)}
			</div>

			{/* Forgot Password Modal */}
			{isForgotOpen && (
				<div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
					<div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl p-6 space-y-5">
						<div className="flex items-center justify-between pb-3 border-b border-slate-100">
							<div className="flex items-center gap-2">
								<HelpCircle size={16} className="text-indigo-600" />
								<h3 className="text-sm font-bold text-slate-900">
									Password Recovery ({role === 'admin' ? 'SuperAdmin' : 'Merchant'})
								</h3>
							</div>
							<button onClick={() => setIsForgotOpen(false)} className="text-slate-400 hover:text-slate-700">
								✕
							</button>
						</div>

						{forgotResult ? (
							<div className="space-y-4 text-xs">
								<div className="p-3.5 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-950 space-y-2">
									<div className="flex items-center gap-2 font-bold text-indigo-900">
										<CheckCircle size={15} className="text-indigo-600 shrink-0" />
										<span>{forgotResult.message}</span>
									</div>
									<p className="text-[11px] leading-relaxed text-slate-700">{forgotResult.instructions}</p>
								</div>

								{role === 'admin' && (
									<div className="p-3 rounded-xl bg-slate-50 border border-slate-200 font-mono text-[11px] text-slate-700 space-y-1">
										<div className="font-bold text-slate-900 flex items-center gap-1.5">
											<Terminal size={13} />
											<span>Server CLI Reset Command:</span>
										</div>
										<div className="text-[10px] text-indigo-700 bg-white p-2 rounded border border-slate-200">
											pnpm run dev (or access MongoDB admin_users collection)
										</div>
									</div>
								)}

								<div className="flex justify-end pt-2">
									<button
										type="button"
										onClick={() => setIsForgotOpen(false)}
										className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs">
										Back to Login
									</button>
								</div>
							</div>
						) : (
							<form onSubmit={handleForgotPassword} className="space-y-4 text-xs">
								<p className="text-slate-600 text-xs leading-relaxed">
									Enter your {role === 'admin' ? 'SuperAdmin email address' : 'Store email or registered domain'} to
									receive account recovery guidance.
								</p>

								<div>
									<label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
										{role === 'admin' ? 'SuperAdmin Email' : 'Store Email or Domain'}
									</label>
									<input
										type="text"
										required
										placeholder={role === 'admin' ? 'admin@singlesolution.io' : 'owner@yourstore.com'}
										value={forgotEmail}
										onChange={(e) => setForgotEmail(e.target.value)}
										className="w-full p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 outline-none focus:border-indigo-500"
									/>
								</div>

								<div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
									<button
										type="button"
										onClick={() => setIsForgotOpen(false)}
										className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold">
										Cancel
									</button>
									<button
										type="submit"
										disabled={forgotLoading}
										className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold shadow-xs disabled:opacity-50">
										{forgotLoading ? 'Checking Account...' : 'Get Recovery Info'}
									</button>
								</div>
							</form>
						)}
					</div>
				</div>
			)}

			<p className="text-center text-xs text-slate-400">
				© {new Date().getFullYear()} SingleSolution Cloud · Enterprise Multi-Tenant Platform
			</p>
		</div>
	);
}

export default function LoginPage() {
	return (
		<div className="min-h-screen bg-slate-50/80 text-slate-900 flex flex-col justify-center items-center p-4 antialiased font-sans">
			<Suspense fallback={<div className="text-xs text-slate-400">Loading authentication...</div>}>
				<LoginForm />
			</Suspense>
		</div>
	);
}
