import React, { useState } from 'react';
import { Lock, Mail, ShieldCheck, Store, ArrowRight, AlertCircle } from 'lucide-react';
import { usePortal } from '../../context/PortalContext';

export default function LoginPage({ onSwitchToSetup }) {
	const { login, hasAdmin } = usePortal();

	const [role, setRole] = useState('admin'); // 'admin' | 'merchant'
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState('');
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleLogin = (e) => {
		e.preventDefault();
		setError('');
		setIsSubmitting(true);

		try {
			login(email, password, role);
		} catch (err) {
			setError(err.message || 'Login failed.');
			setIsSubmitting(false);
		}
	};

	return (
		<div className="min-h-screen bg-slate-50/80 text-slate-900 flex items-center justify-center p-4 antialiased font-sans">
			<div className="w-full max-w-md p-8 rounded-2xl bg-white border border-slate-200/80 shadow-md space-y-6 transition-all duration-200">
				{/* Header */}
				<div className="text-center space-y-2">
					<div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-indigo-600 text-white shadow-sm mb-2 transition-transform duration-200 hover:scale-105">
						{role === 'admin' ? <ShieldCheck size={24} /> : <Store size={24} />}
					</div>
					<h1 className="text-xl font-bold tracking-tight text-slate-900">
						{role === 'admin' ? 'SuperAdmin Control Console' : 'Merchant Storefront Portal'}
					</h1>
					<p className="text-xs text-slate-500">
						{role === 'admin'
							? 'Sign in with your master credentials to manage the platform.'
							: 'Sign in with your merchant store email & password created by the administrator.'}
					</p>
				</div>

				{/* Role Tabs */}
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

				{error && (
					<div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2 transition-all duration-150">
						<AlertCircle size={15} className="shrink-0" />
						<span>{error}</span>
					</div>
				)}

				<form onSubmit={handleLogin} className="space-y-4">
					<div>
						<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">
							{role === 'admin' ? 'SuperAdmin Email' : 'Merchant Store Email'}
						</label>
						<div className="relative">
							<Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
							<input
								type="email"
								placeholder={role === 'admin' ? 'admin@platform.io' : 'admin@sistersboutique.com'}
								required
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all duration-150"
							/>
						</div>
					</div>

					<div>
						<label className="block text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1.5">Password</label>
						<div className="relative">
							<Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
							<input
								type="password"
								placeholder="••••••••"
								required
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="w-full pl-10 pr-4 py-2 rounded-xl bg-slate-50/50 border border-slate-200 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all duration-150"
							/>
						</div>
					</div>

					<button
						type="submit"
						disabled={isSubmitting}
						className="w-full py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-bold text-xs active:scale-[0.99] transition-all duration-150 flex items-center justify-center gap-2 cursor-pointer shadow-xs hover:shadow-sm">
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

				{!hasAdmin && (
					<div className="pt-3 border-t border-slate-100 text-center">
						<button
							type="button"
							onClick={onSwitchToSetup}
							className="text-xs text-slate-500 hover:text-indigo-600 underline cursor-pointer transition-colors">
							No SuperAdmin Account Configured? Run Setup Wizard →
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
