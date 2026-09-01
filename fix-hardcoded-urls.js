const fs = require('fs');
const path = require('path');

const appNames = ['analytics', 'automation', 'chatbot', 'loyalty', 'seo'];

// 1. Update FeatureManager.jsx across all apps
for (const app of appNames) {
	const fmPath = path.join(__dirname, 'apps', app, 'src', 'views', 'FeatureManager.jsx');
	if (fs.existsSync(fmPath)) {
		let content = fs.readFileSync(fmPath, 'utf8');

		// Ensure useAppSecurity is imported
		if (!content.includes('useAppSecurity')) {
			content = content.replace(
				"import React, { useState } from 'react';",
				"import React, { useState } from 'react';\nimport { useAppSecurity } from '@saas/ui/auth/AppAuthGuard';",
			);
		}

		// Ensure hook is called
		if (!content.includes('const { session, portalUrl } = useAppSecurity')) {
			content = content.replace(
				'export default function FeatureManager() {',
				"export default function FeatureManager() {\n\tconst { session, portalUrl } = useAppSecurity() || {};\n\tconst effectivePortal = portalUrl || session?.portalUrl || '';\n\tconst billingLink = effectivePortal ? `${effectivePortal}/${session?.role === 'merchant' ? 'merchant/billing' : 'admin/billing'}` : '#';",
			);
		}

		content = content.replace(/href="http:\/\/localhost:3000\/admin\/billing"/g, 'href={billingLink}');

		fs.writeFileSync(fmPath, content);
		console.log(`Updated FeatureManager for ${app}`);
	}
}

// 2. Update layout.jsx across all apps to pass dynamic footerLink
for (const app of appNames) {
	const layoutPath = path.join(__dirname, 'apps', app, 'app', '(dashboard)', 'layout.jsx');
	if (fs.existsSync(layoutPath)) {
		let content = fs.readFileSync(layoutPath, 'utf8');

		// Ensure portalUrl is destructured from useAppSecurity
		if (!content.includes('portalUrl')) {
			content = content.replace(
				'const { session, logoutApp } = useAppSecurity() || {};',
				'const { session, logoutApp, portalUrl } = useAppSecurity() || {};',
			);
		}

		if (!content.includes('footerLink=')) {
			content = content.replace(
				'<AppLayout',
				"<AppLayout\n\t\t\tfooterLink={{ to: portalUrl || session?.portalUrl || '#', label: 'Master Portal' }}",
			);
		}

		fs.writeFileSync(layoutPath, content);
		console.log(`Updated layout for ${app}`);
	}
}

// 3. Update AppContext.jsx and StorefrontContext.jsx
for (const app of appNames) {
	const ctxPath =
		app === 'analytics'
			? path.join(__dirname, 'apps', 'analytics', 'src', 'context', 'StorefrontContext.jsx')
			: path.join(__dirname, 'apps', app, 'src', 'context', 'AppContext.jsx');

	if (fs.existsSync(ctxPath)) {
		let content = fs.readFileSync(ctxPath, 'utf8');

		content = content.replace(
			"const portalUrl = process.env.PORTAL_URL || 'http://localhost:3000';",
			"const portalUrl = (typeof window !== 'undefined' && window.__PORTAL_URL__) || session?.portalUrl || process.env.PORTAL_URL || 'http://localhost:3000';",
		);

		fs.writeFileSync(ctxPath, content);
		console.log(`Updated Context for ${app}`);
	}
}

// 4. Update apps/*/app/api/features/route.js to query portal_connections DB
for (const app of appNames) {
	const featRoutePath = path.join(__dirname, 'apps', app, 'app', 'api', 'features', 'route.js');
	if (fs.existsSync(featRoutePath)) {
		let content = fs.readFileSync(featRoutePath, 'utf8');

		const targetBlock = "const portalUrl = process.env.PORTAL_URL || 'http://localhost:3000';";
		const replacementBlock = `let portalUrl = process.env.PORTAL_URL;
		if (!portalUrl && db) {
			try {
				const conn = await db.collection('portal_connections').findOne({}, { sort: { lastHandshake: -1 } });
				if (conn && conn.portalUrl) portalUrl = conn.portalUrl;
			} catch {}
		}
		if (!portalUrl) portalUrl = 'http://localhost:3000';`;

		content = content.replace(targetBlock, replacementBlock);
		fs.writeFileSync(featRoutePath, content);
		console.log(`Updated features route for ${app}`);
	}
}

// 5. Update Analytics specific views with hardcoded localhost
const analyticsViews = [
	'Settings.jsx',
	'SpeedInsights.jsx',
	'MetaCapiIntegration.jsx',
	'WebhooksIntegration.jsx',
	'Ga4Integration.jsx',
	'DirectApiConnect.jsx',
	'Dashboard.jsx',
];

for (const view of analyticsViews) {
	const vPath = path.join(__dirname, 'apps', 'analytics', 'src', 'views', view);
	if (fs.existsSync(vPath)) {
		let content = fs.readFileSync(vPath, 'utf8');

		// If Settings.jsx, fix edgeEndpoint
		if (view === 'Settings.jsx') {
			content = content.replace(
				"edgeEndpoint: 'http://localhost:5001/api/telemetry/event',",
				"edgeEndpoint: typeof window !== 'undefined' ? `${window.location.origin}/api/events` : '/api/events',",
			);
		}

		// Ensure portalUrl is destructured from useStorefront
		if (content.includes('useStorefront()') && !content.includes('portalUrl,') && !content.includes(', portalUrl')) {
			content = content.replace('const { ', 'const { portalUrl, ');
		}

		// Replace http://localhost:3000/admin/tenants with dynamic
		content = content.replace(
			/href="http:\/\/localhost:3000\/admin\/tenants"/g,
			'href={portalUrl ? `${portalUrl}/admin/tenants` : "#"}',
		);

		content = content.replace(
			/href=\{session\?\.portalUrl \? `\$\{session\.portalUrl\}\/admin\/tenants` : "#"\}/g,
			'href={portalUrl ? `${portalUrl}/admin/tenants` : "#"}',
		);

		fs.writeFileSync(vPath, content);
		console.log(`Updated analytics view ${view}`);
	}
}

console.log('All hardcoded URLs successfully updated to dynamic endpoints!');
