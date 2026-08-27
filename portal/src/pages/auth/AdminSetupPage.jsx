import React, { useState } from 'react';
import { ShieldCheck, ArrowRight, Lock, User, Mail, Building, AlertCircle } from 'lucide-react';
import { usePortal } from '../../context/PortalContext';

export default function AdminSetupPage({ onComplete }) {
	const { setupAdmin } = usePortal();

	const [form, setForm] = useState({
		name: '',
		email: '',
		password: '',
		confirmPassword: '',
		orgName: 'SingleSolution Cloud Platform',
	});

	const [error, setError] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = (e) => {
		e.preventDefault();
		setError('');

		if (!form.name.trim() || !form.email.trim() || !form.password) {
			setError('All fields are required.');
			return;
		}

		if (form.password.length < 6) {
			setError('Password must be at least 6 characters.');
			return;
		}

		if (form.password !== form.confirmPassword) {
			setError('Passwords do not match.');
			return;
		}

		setIsSubmitting(true);
		try {
			setupAdmin({
				name: form.name,
				email: form.email,
				password: form.password,
				orgName: form.orgName,
			});
			if (onComplete) onComplete();
		} catch (err) {
			setError(err.message || 'Setup failed.');
			setIsSubmitting(false);
		}
	};

	return (
		<div className="min-h-screen bg-slate-50/80 text-slate-900 flex items-center justify-center p-4 antialiased font-sans">
			<div className="w-full max-w-md p-8 rounded-2xl bg-white border border-slate-200/80 shadow-md space-y-6 transition-all duration-200">
				{/* Brand Header */}
				<div className="text-center space-y-2">
					<div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-600 text-white shadow-sm mb-2 transition-transform duration-200 hover:scale-105">
						<ShieldCheck size={24} />
					</div>
					<h1 className="text-xl font-bold tracking-tight text-slate-900">Initialize SuperAdmin</h1>
					<p className="text-xs text-slate-500">
						First-time installation detected. Create the root SuperAdmin account to govern your SaaS platform.
					</p>
				</div>

				{error && (
					<div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2 transition-all duration-150">
						<AlertCircle size={15} className="shrink-0" />
						<span>{error}</span>
					</div>
				)}

				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
							SuperAdmin Full Name
						</label>
						<div className="relative">
							<User size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
							<input
								type="text"
								placeholder="e.g. John Doe"
								required
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
								className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all duration-150"
							/>
						</div>
					</div>

					<div>
						<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
							Work Email Address
						</label>
						<div className="relative">
							<Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
							<input
								type="email"
								placeholder="admin@platform.io"
								required
								value={form.email}
								onChange={(e) => setForm({ ...form, email: e.target.value })}
								className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all duration-150"
							/>
						</div>
					</div>

					<div>
						<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
							Organization / Platform Title
						</label>
						<div className="relative">
							<Building size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
							<input
								type="text"
								placeholder="SingleSolution SaaS Cloud"
								value={form.orgName}
								onChange={(e) => setForm({ ...form, orgName: e.target.value })}
								className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all duration-150"
							/>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
								Master Password
							</label>
							<div className="relative">
								<Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
								<input
									type="password"
									placeholder="••••••••"
									required
									value={form.password}
									onChange={(e) => setForm({ ...form, password: e.target.value })}
									className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all duration-150"
								/>
							</div>
						</div>

						<div>
							<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
								Confirm Password
							</label>
							<div className="relative">
								<Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
								<input
									type="password"
									placeholder="••••••••"
									required
									value={form.confirmPassword}
									onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
									className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all duration-150"
								/>
							</div>
						</div>
					</div>

					<button
						type="submit"
						disabled={isSubmitting}
						className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-xs active:scale-[0.99] transition-all duration-150 flex items-center justify-center gap-2 cursor-pointer shadow-xs hover:shadow-sm">
						<span>{isSubmitting ? 'Provisioning Master Cluster...' : 'Complete SuperAdmin Setup'}</span>
						<ArrowRight size={14} />
					</button>
				</form>
			</div>
		</div>
	);
}
