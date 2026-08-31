'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePortal } from '../../context/PortalContext';
import { ShieldCheck, User, Mail, Lock, Building, ArrowRight, AlertCircle, Eye, EyeOff, Check, Zap } from 'lucide-react';

export default function SetupPage() {
	const router = useRouter();
	const { setupAdmin, hasAdmin, isLoading } = usePortal();

	const [name, setName] = useState('');
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [showPassword, setShowPassword] = useState(false);
	const [showConfirmPassword, setShowConfirmPassword] = useState(false);
	const [orgName, setOrgName] = useState('SingleSolution Global');
	const [error, setError] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);

	// If SuperAdmin is already configured in the database, lock down setup page and redirect to login
	useEffect(() => {
		if (!isLoading && hasAdmin) {
			router.replace('/login');
		}
	}, [hasAdmin, isLoading, router]);

	const handleSubmit = async (e) => {
		e.preventDefault();
		setError('');

		if (password.length < 6) {
			setError('Password must be at least 6 characters long.');
			return;
		}

		if (password !== confirmPassword) {
			setError('Passwords do not match.');
			return;
		}

		setIsSubmitting(true);

		try {
			await setupAdmin({ name, email, password, orgName });
			router.replace('/admin');
		} catch (err) {
			setError(err.message || 'Setup failed.');
			setIsSubmitting(false);
		}
	};

	if (isLoading) {
		return (
			<div className="min-h-screen bg-slate-50/80 flex flex-col items-center justify-center space-y-4">
				<div className="w-10 h-10 rounded-2xl bg-indigo-600 text-white flex items-center justify-center shadow-lg shadow-indigo-200 animate-pulse">
					<Zap size={20} />
				</div>
				<div className="text-xs font-bold text-slate-400">Checking cluster initialization status...</div>
			</div>
		);
	}

	if (hasAdmin) {
		return (
			<div className="min-h-screen bg-slate-50/80 flex flex-col items-center justify-center p-4">
				<div className="p-6 max-w-sm w-full bg-white rounded-2xl border border-slate-200 shadow-md text-center space-y-3">
					<ShieldCheck size={32} className="text-emerald-600 mx-auto" />
					<h2 className="text-base font-bold text-slate-900">SuperAdmin Configured</h2>
					<p className="text-xs text-slate-500">Root account already exists. Redirecting to login...</p>
				</div>
			</div>
		);
	}

	const isMatch = password && confirmPassword && password === confirmPassword;

	return (
		<div className="min-h-screen bg-slate-50/80 text-slate-900 flex flex-col justify-center items-center p-4 antialiased font-sans">
			<div className="w-full max-w-md space-y-6">
				{/* Header */}
				<div className="text-center space-y-2">
					<div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-600 text-white shadow-md shadow-indigo-100 mb-1 transition-transform hover:scale-105">
						<ShieldCheck size={24} />
					</div>
					<h1 className="text-2xl font-bold tracking-tight text-slate-900">Cluster Provisioning Wizard</h1>
					<p className="text-xs text-slate-500 max-w-sm mx-auto">
						Configure your master SuperAdmin root credentials to initialize the platform.
					</p>
				</div>

				{/* Card */}
				<div className="p-8 rounded-2xl bg-white border border-slate-200/80 shadow-md space-y-6">
					{error && (
						<div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
							<AlertCircle size={15} className="shrink-0" />
							<span>{error}</span>
						</div>
					)}

					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
								Your Full Name
							</label>
							<div className="relative">
								<User size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
								<input
									type="text"
									required
									placeholder="e.g. Farhan Nadeem"
									value={name}
									onChange={(e) => setName(e.target.value)}
									disabled={isSubmitting}
									className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
								/>
							</div>
						</div>

						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
								SuperAdmin Email
							</label>
							<div className="relative">
								<Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
								<input
									type="email"
									required
									placeholder="admin@singlesolution.io"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									disabled={isSubmitting}
									className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
								/>
							</div>
						</div>

						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
								Organization Name
							</label>
							<div className="relative">
								<Building size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
								<input
									type="text"
									required
									value={orgName}
									onChange={(e) => setOrgName(e.target.value)}
									disabled={isSubmitting}
									className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
								/>
							</div>
						</div>

						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
								Master Password (min. 6 chars)
							</label>
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

						<div>
							<div className="flex items-center justify-between mb-1.5">
								<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider">
									Confirm Password
								</label>
								{confirmPassword && (
									<span
										className={`text-[10px] font-bold flex items-center gap-1 ${isMatch ? 'text-emerald-600' : 'text-rose-500'}`}>
										{isMatch ? <Check size={12} /> : null}
										<span>{isMatch ? 'Passwords match' : 'Passwords do not match'}</span>
									</span>
								)}
							</div>
							<div className="relative flex items-center">
								<Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
								<input
									type={showConfirmPassword ? 'text' : 'password'}
									required
									placeholder="••••••••••••"
									value={confirmPassword}
									onChange={(e) => setConfirmPassword(e.target.value)}
									disabled={isSubmitting}
									className="w-full pl-10 pr-10 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
								/>
								<button
									type="button"
									onClick={() => setShowConfirmPassword(!showConfirmPassword)}
									className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
									title={showConfirmPassword ? 'Hide password' : 'Show password'}>
									{showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
								</button>
							</div>
						</div>

						<button
							type="submit"
							disabled={isSubmitting || (password.length > 0 && !isMatch)}
							className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-xs active:scale-[0.99] transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xs hover:shadow-sm disabled:opacity-50">
							<span>{isSubmitting ? 'Provisioning Master Admin...' : 'Initialize & Launch Control Plane'}</span>
							<ArrowRight size={14} />
						</button>
					</form>
				</div>
			</div>
		</div>
	);
}
