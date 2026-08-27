import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AppLayout } from '@saas/ui/layout/AppLayout';
import { AppAuthGuard, useAppSecurity, FeatureLockScreen } from '@saas/ui/auth/AppAuthGuard';
import {
	MessageSquare,
	LayoutDashboard,
	Settings,
	BarChart3,
	Bot,
	Sparkles,
	Globe,
	LogOut,
	Database,
	UserCheck,
	Languages,
} from 'lucide-react';

import Dashboard from './pages/Dashboard.jsx';
import ConversationsList from './pages/ConversationsList.jsx';
import ConversationDetail from './pages/ConversationDetail.jsx';
import BotConfig from './pages/BotConfig.jsx';
import Analytics from './pages/Analytics.jsx';
import SettingsPage from './pages/Settings.jsx';
import GuestLanding from './pages/GuestLanding.jsx';
import ChatbotSandbox from './pages/ChatbotSandbox.jsx';

function KnowledgeBasePage() {
	const { hasFeature } = useAppSecurity() || {};
	if (!hasFeature('ai_kb')) {
		return (
			<FeatureLockScreen
				featureName="Custom Knowledge Base Ingestion"
				creditCost={40}
				desc="Train your AI agent on store catalog PDFs, returns policies, and FAQ docs."
			/>
		);
	}

	return (
		<div className="space-y-6 max-w-3xl antialiased">
			<div className="space-y-1">
				<h1 className="text-xl font-bold text-slate-900">Knowledge Base Ingestion</h1>
				<p className="text-xs text-slate-500">Upload documents and URL sources for vector search</p>
			</div>
			<div className="p-8 rounded-3xl bg-white border border-slate-200 shadow-xs text-center space-y-4">
				<div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto">
					<Database size={24} />
				</div>
				<div className="space-y-1 max-w-sm mx-auto">
					<h3 className="font-bold text-sm text-slate-900">Custom Document Embeddings Active</h3>
					<p className="text-xs text-slate-500">
						Your AI assistant searches uploaded catalog documents in real-time before generating responses.
					</p>
				</div>
			</div>
		</div>
	);
}

function EscalationRoutingPage() {
	const { hasFeature } = useAppSecurity() || {};
	if (!hasFeature('human_escalation')) {
		return (
			<FeatureLockScreen
				featureName="Human Agent Escalation"
				creditCost={25}
				desc="Route complex queries to human support agents on WhatsApp and Slack."
			/>
		);
	}

	return (
		<div className="space-y-6 max-w-3xl antialiased">
			<div className="space-y-1">
				<h1 className="text-xl font-bold text-slate-900">Human Escalation Routing</h1>
				<p className="text-xs text-slate-500">Forward escalated chats to live staff queues</p>
			</div>
			<div className="p-8 rounded-3xl bg-white border border-slate-200 shadow-xs text-center space-y-4">
				<div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto">
					<UserCheck size={24} />
				</div>
				<div className="space-y-1 max-w-sm mx-auto">
					<h3 className="font-bold text-sm text-slate-900">WhatsApp & Slack Webhook Dispatch Active</h3>
					<p className="text-xs text-slate-500">
						When the AI detects frustration or high-value sales questions, it triggers instant staff notifications.
					</p>
				</div>
			</div>
		</div>
	);
}

function ChatbotApp() {
	const { session, logoutApp, hasFeature, enabledFeatures = [] } = useAppSecurity() || {};

	const navigation = [
		{
			label: 'Core Assistant',
			items: [
				{ name: 'Dashboard', href: '/', icon: LayoutDashboard },
				{ name: 'Live Inbox', href: '/conversations', icon: MessageSquare },
				{ name: 'Bot Prompts & Rules', href: '/config', icon: Bot },
				{
					name: 'Knowledge Base',
					href: '/knowledge-base',
					icon: Database,
					badge: hasFeature('ai_kb') ? 'Active' : 'Locked',
				},
				{
					name: 'Human Escalation',
					href: '/escalation',
					icon: UserCheck,
					badge: hasFeature('human_escalation') ? 'Active' : 'Locked',
				},
				{ name: 'Analytics', href: '/analytics', icon: BarChart3 },
				{ name: 'Settings', href: '/settings', icon: Settings },
			],
		},
		{
			label: 'Sandbox & Public',
			items: [
				{ name: 'Test Simulator', href: '/sandbox', icon: Sparkles },
				{ name: 'Guest Overview', href: '/welcome', icon: Globe },
			],
		},
	];

	const activeCount = enabledFeatures.includes('*') ? 4 : enabledFeatures.length;

	return (
		<AppLayout
			appName="AI Chat Assistant"
			appSubtitle={session?.tenantName || 'Workspace'}
			navigation={navigation}
			headerRight={
				session && (
					<div className="flex items-center gap-3">
						<div className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-xl bg-indigo-50 border border-indigo-100 text-[11px] font-semibold text-indigo-900">
							<span>{activeCount} of 4 Modules Active</span>
						</div>
						<div className="text-xs text-right hidden sm:block">
							<div className="font-bold text-slate-900">{session.tenantName}</div>
							<div className="text-[10px] text-slate-500 font-mono">{session.domain}</div>
						</div>
						<button
							type="button"
							onClick={logoutApp}
							title="Lock Session"
							className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer">
							<LogOut size={15} />
						</button>
					</div>
				)
			}>
			<Routes>
				<Route path="/" element={<Dashboard />} />
				<Route path="/welcome" element={<GuestLanding />} />
				<Route path="/sandbox" element={<ChatbotSandbox />} />
				<Route path="/conversations" element={<ConversationsList />} />
				<Route path="/conversations/:id" element={<ConversationDetail />} />
				<Route path="/config" element={<BotConfig />} />
				<Route path="/knowledge-base" element={<KnowledgeBasePage />} />
				<Route path="/escalation" element={<EscalationRoutingPage />} />
				<Route path="/analytics" element={<Analytics />} />
				<Route path="/settings" element={<SettingsPage />} />
			</Routes>
		</AppLayout>
	);
}

export default function App() {
	return (
		<BrowserRouter>
			<AppAuthGuard productId="chatbot" appName="AI Chat Assistant">
				<ChatbotApp />
			</AppAuthGuard>
		</BrowserRouter>
	);
}
