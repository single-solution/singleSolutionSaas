const fs = require('fs');
const path = require('path');

const apps = ['chatbot', 'loyalty', 'seo', 'automation'];

// We can extract DEFAULT_APPS manually since we know them
const defaultApps = {
	seo: [
		{ id: 'schema', name: 'Product Schema Ingestion', creditCost: 30, desc: 'Automatic Rich Snippets and Breadcrumb markup', icon: 'Search', category: 'Growth' },
		{ id: 'keywords', name: 'Keyword Tracker Radar', creditCost: 45, desc: 'Daily organic ranking telemetry for store catalogs', icon: 'TrendingUp', category: 'Growth' },
		{ id: 'audits', name: 'Technical Lighthouse Probes', creditCost: 25, desc: 'Automated Core Web Vitals performance scanning', icon: 'Activity', category: 'Technical' }
	],
	loyalty: [
		{ id: 'points', name: 'Points & Tier Engine', creditCost: 40, desc: 'Earn points per purchase with tiered discount ladders', icon: 'Gift', category: 'Retention' },
		{ id: 'referrals', name: 'Referral Link Tracking', creditCost: 35, desc: 'Viral friend-referral voucher distribution', icon: 'Share2', category: 'Growth' },
		{ id: 'vip', name: 'Exclusive Member Perks', creditCost: 30, desc: 'Early access and private sale badges for VIP shoppers', icon: 'Crown', category: 'Retention' }
	],
	chatbot: [
		{ id: 'conversations', name: 'AI Order Lookup & FAQ', creditCost: 60, desc: 'Automated natural language customer resolution', icon: 'Bot', category: 'CX' },
		{ id: 'handoff', name: 'Human Live Agent Handoff', creditCost: 40, desc: 'Seamless escalation to store support operators', icon: 'UserCircle', category: 'CX' },
		{ id: 'widget', name: 'Floating Storefront Widget', creditCost: 20, desc: 'Customizable branded chat widget snippet', icon: 'MessageSquare', category: 'CX' }
	],
	automation: [
		{ id: 'triggers', name: 'Real-Time Event Triggers', creditCost: 45, desc: 'Custom trigger rules on order creation and inventory low', icon: 'Zap', category: 'DevOps' },
		{ id: 'notifications', name: 'SMS & WhatsApp Gateway', creditCost: 50, desc: 'Direct transactional dispatch via third-party providers', icon: 'MessageCircle', category: 'Comms' },
		{ id: 'webhooks_out', name: 'Custom Outbound Webhooks', creditCost: 25, desc: 'Signed payload dispatch with retry queues', icon: 'Webhook', category: 'DevOps' }
	]
};

const analyticsRouteTemplate = fs.readFileSync('apps/analytics/app/api/features/route.js', 'utf8');
const analyticsContextTemplate = fs.readFileSync('apps/analytics/src/context/StorefrontContext.jsx', 'utf8');
const analyticsFeatureManagerTemplate = fs.readFileSync('apps/analytics/src/views/FeatureManager.jsx', 'utf8');

apps.forEach(app => {
	console.log(`Processing app: ${app}`);
	
	// 1. Create API Route
	const apiDir = `apps/${app}/app/api/features`;
	fs.mkdirSync(apiDir, { recursive: true });
	let routeContent = analyticsRouteTemplate.replace(/connectAnalyticsDb/g, 'connectPortalDb').replace(/'analytics'/g, `'${app}'`);
	// Replace DEFAULT_FEATURES
	const regex = /export const DEFAULT_FEATURES = \[[\s\S]*?\];/;
	const replacement = `export const DEFAULT_FEATURES = ${JSON.stringify(defaultApps[app], null, '\t')};`;
	routeContent = routeContent.replace(regex, replacement);
	// Analytics uses connectAnalyticsDb which connects to a specific db. Wait, does connectPortalDb export connectAnalyticsDb?
	// The route imports connectAnalyticsDb from `../../../lib/db.js`.
	// We should just replace it with connectPortalDb and import it from the app's lib/db.js or the shared lib.
	// Actually, the analytics app has `apps/analytics/lib/db.js`. Do other apps have this? Yes! Let's just blindly copy it but change connectAnalyticsDb to the standard connect pattern, or just replace connectAnalyticsDb with `connect${app.charAt(0).toUpperCase() + app.slice(1)}Db`.
	const dbFuncName = `connect${app.charAt(0).toUpperCase() + app.slice(1)}Db`;
	routeContent = routeContent.replace(/connectAnalyticsDb/g, dbFuncName);
	fs.writeFileSync(`${apiDir}/route.js`, routeContent);

	// 2. Create AppContext
	const contextDir = `apps/${app}/src/context`;
	fs.mkdirSync(contextDir, { recursive: true });
	let contextContent = analyticsContextTemplate
		.replace(/StorefrontContext/g, 'AppContext')
		.replace(/useStorefront/g, 'useAppContext')
		.replace(/StorefrontProvider/g, 'AppProvider');
	// Replace default enabled features with the app's features
	const defaultFeaturesList = defaultApps[app].map(f => `'${f.id}'`).join(', ');
	contextContent = contextContent.replace(/\[\s*'core_traffic'[\s\S]*?'broken_links',\s*\]/, `[${defaultFeaturesList}]`);
	fs.writeFileSync(`${contextDir}/AppContext.jsx`, contextContent);

	// 3. Create FeatureManager
	const viewsDir = `apps/${app}/src/views`;
	fs.mkdirSync(viewsDir, { recursive: true });
	let fmContent = analyticsFeatureManagerTemplate
		.replace(/StorefrontContext/g, 'AppContext')
		.replace(/useStorefront/g, 'useAppContext')
		.replace(/\.\.\/\.\.\/\.\.\/\.\.\/shared/g, '../../../../shared');
	fs.writeFileSync(`${viewsDir}/FeatureManager.jsx`, fmContent);

	// 4. Update Layout
	const layoutPath = `apps/${app}/app/(dashboard)/layout.jsx`;
	if (fs.existsSync(layoutPath)) {
		let layoutContent = fs.readFileSync(layoutPath, 'utf8');
		
		// Add AppContext import
		if (!layoutContent.includes('AppContext')) {
			layoutContent = layoutContent.replace(
				/import { useAppSecurity } from '@saas\/ui\/auth\/AppAuthGuard';/,
				`import { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';\nimport { useAppContext } from '../../src/context/AppContext';\nimport { Building2, Coins, LogOut } from 'lucide-react';`
			);
		}

		// Add context hooks
		if (!layoutContent.includes('const { isAdmin, stores')) {
			layoutContent = layoutContent.replace(
				/const { session, logoutApp } = useAppSecurity\(\) \|\| \{\};/,
				`const { session, logoutApp } = useAppSecurity() || {};\n\tconst { isAdmin, stores, activeStore, selectedStoreId, setSelectedStoreId, totalMonthlyCost, enabledFeatures } = useAppContext() || {};`
			);
		}

		// Replace headerRight
		const headerRightTemplate = `headerRight={
				<div className="flex items-center gap-3">
					{isAdmin && stores && (
						<div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 border border-slate-200 text-xs">
							<Building2 size={13} className="text-indigo-600" />
							<span className="text-slate-500 font-bold hidden sm:inline">Store:</span>
							{stores.length > 0 ? (
								<select
									value={selectedStoreId}
									onChange={(e) => setSelectedStoreId(e.target.value)}
									className="bg-transparent font-bold text-slate-900 focus:outline-none cursor-pointer">
									{stores.map((s) => (
										<option key={s.id} value={s.id}>
											{s.name} ({s.domain})
										</option>
									))}
								</select>
							) : (
								<span className="font-semibold text-slate-400">No Stores Registered</span>
							)}
						</div>
					)}

					<div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-xl bg-amber-50 border border-amber-200 text-xs font-bold text-amber-900">
						<Coins size={13} className="text-amber-600" />
						<span>\${totalMonthlyCost || 0}</span>
						<span className="text-[10px] text-amber-600 font-normal">/mo</span>
					</div>

					<div className="text-xs text-right hidden sm:block">
						<div className="font-bold text-slate-900">{activeStore?.name || session?.tenantName || 'SuperAdmin'}</div>
						<div className="text-[10px] text-slate-500 font-mono">
							{activeStore?.domain || session?.domain || 'Platform Root'}
						</div>
					</div>

					<button
						type="button"
						onClick={logoutApp}
						title="Sign Out / Back to Portal"
						className="p-2 rounded-xl bg-slate-100 hover:bg-rose-50 text-slate-500 hover:text-rose-600 transition-colors cursor-pointer">
						<LogOut size={16} />
					</button>
				</div>
			}`;
		
		layoutContent = layoutContent.replace(/headerRight=\{[\s\S]*?\}>/, `${headerRightTemplate}>`);
		fs.writeFileSync(layoutPath, layoutContent);
	}
});

console.log('Scaffolding complete!');
