import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const DEFAULT_APPS = [
	{
		id: 'analytics',
		name: 'Analytics Suite',
		status: 'operational',
		url: 'http://localhost:5001',
		icon: 'BarChart3',
		color: 'indigo',
		version: 'v1.4.0',
		desc: 'Real-time store traffic analysis, conversion funnels, webhook event processing, and UTM campaign tracking.',
		features: [
			{
				id: 'core_traffic',
				name: 'Real-Time Traffic Radar',
				creditCost: 30,
				desc: 'Live visitor counter, session graphs, device/OS & city geo breakdown',
			},
			{
				id: 'funnel_dropoff',
				name: '5-Stage Conversion Funnel',
				creditCost: 35,
				desc: 'Step-by-step buyer drop-off diagnostics & GMV attribution',
			},
			{
				id: 'product_merch',
				name: 'Product Merchandising',
				creditCost: 30,
				desc: 'SKU velocity, hot sellers vs attention-needed catalog items',
			},
			{
				id: 'speed_insights',
				name: 'Speed & Core Web Vitals',
				creditCost: 25,
				desc: 'Real-device P75 scoring (LCP, CLS, INP, TTFB) & slowest URLs',
			},
			{
				id: 'search_analytics',
				name: 'Search Query Intelligence',
				creditCost: 25,
				desc: 'Top catalog search terms & zero-result demand tracking',
			},
			{
				id: 'broken_links',
				name: '404 Broken Link Radar',
				creditCost: 15,
				desc: 'Broken page visits and incoming referral attribution',
			},
			{
				id: 'meta_capi',
				name: 'Meta Conversions API (CAPI)',
				creditCost: 30,
				desc: 'Server-side Facebook/Instagram tracking with test event codes',
			},
			{
				id: 'ga4_sync',
				name: 'Google Analytics 4 Protocol',
				creditCost: 20,
				desc: 'Direct server-to-server GA4 measurement dispatching',
			},
			{
				id: 'custom_webhooks',
				name: 'Real-Time Outbound Webhooks',
				creditCost: 25,
				desc: 'Instant webhook dispatches on orders, cart events, and spikes',
			},
		],
	},
	{
		id: 'seo',
		name: 'SEO & Schema Hub',
		status: 'operational',
		url: 'http://localhost:5002',
		icon: 'Search',
		color: 'emerald',
		version: 'v1.2.0',
		desc: 'Automated JSON-LD schema injection, SERP ranking radar, core web vital auditing, and meta tag optimization.',
		features: [
			{
				id: 'schema',
				name: 'Product Schema Ingestion',
				creditCost: 30,
				desc: 'Automatic Rich Snippets and Breadcrumb markup',
			},
			{
				id: 'keywords',
				name: 'Keyword Tracker Radar',
				creditCost: 45,
				desc: 'Daily organic ranking telemetry for store catalogs',
			},
			{
				id: 'audits',
				name: 'Technical Lighthouse Probes',
				creditCost: 25,
				desc: 'Automated Core Web Vitals performance scanning',
			},
		],
	},
	{
		id: 'loyalty',
		name: 'Loyalty & VIP Rewards',
		status: 'operational',
		url: 'http://localhost:5003',
		icon: 'Gift',
		color: 'amber',
		version: 'v1.1.0',
		desc: 'Customer point wallets, tiered VIP badges, referral incentives, and automated reward redemption checkout perks.',
		features: [
			{
				id: 'points',
				name: 'Points & Tier Engine',
				creditCost: 40,
				desc: 'Earn points per purchase with tiered discount ladders',
			},
			{ id: 'referrals', name: 'Referral Link Tracking', creditCost: 35, desc: 'Viral friend-referral voucher distribution' },
			{
				id: 'vip',
				name: 'Exclusive Member Perks',
				creditCost: 30,
				desc: 'Early access and private sale badges for VIP shoppers',
			},
		],
	},
	{
		id: 'chatbot',
		name: 'AI Support Assistant',
		status: 'operational',
		url: 'http://localhost:5004',
		icon: 'Bot',
		color: 'purple',
		version: 'v1.3.0',
		desc: '24/7 AI-powered conversational sales assistant, FAQ answering, order lookup, and customer support ticket routing.',
		features: [
			{
				id: 'conversations',
				name: 'AI Order Lookup & FAQ',
				creditCost: 60,
				desc: 'Automated natural language customer resolution',
			},
			{
				id: 'handoff',
				name: 'Human Live Agent Handoff',
				creditCost: 40,
				desc: 'Seamless escalation to store support operators',
			},
			{ id: 'widget', name: 'Floating Storefront Widget', creditCost: 20, desc: 'Customizable branded chat widget snippet' },
		],
	},
	{
		id: 'automation',
		name: 'Automation & Webhooks',
		status: 'operational',
		url: 'http://localhost:5005',
		icon: 'Zap',
		color: 'rose',
		version: 'v1.0.0',
		desc: 'No-code event trigger builder, SMS & WhatsApp notifications, Slack alert webhooks, and abandoned checkout flows.',
		features: [
			{
				id: 'triggers',
				name: 'Real-Time Event Triggers',
				creditCost: 45,
				desc: 'Custom trigger rules on order creation and inventory low',
			},
			{
				id: 'notifications',
				name: 'SMS & WhatsApp Gateway',
				creditCost: 50,
				desc: 'Direct transactional dispatch via third-party providers',
			},
			{
				id: 'webhooks_out',
				name: 'Custom Outbound Webhooks',
				creditCost: 25,
				desc: 'Signed payload dispatch with retry queues',
			},
		],
	},
];

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET() {
	try {
		const db = await connectPortalDb();
		if (db) {
			const apps = await db.collection('apps').find({}).toArray();
			if (apps && apps.length > 0) {
				return NextResponse.json(
					apps.map(({ _id, ...app }) => app),
					{ headers: CORS_HEADERS },
				);
			}
		}
		return NextResponse.json([], { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json([], { headers: CORS_HEADERS });
	}
}

export async function POST(req) {
	try {
		const body = await req.json().catch(() => ({}));
		const { id, originalId, name, status, url, secretKey, features, defaultPrice, description, desc } =
			body;

		if (!id || !name || !url) {
			return NextResponse.json({ error: 'App Name and URL are required' }, { status: 400, headers: CORS_HEADERS });
		}

		const appRecord = {
			id: id.trim().toLowerCase(),
			name: name.trim(),
			status: status || 'operational',
			url: url.trim(),
			secretKey: secretKey?.trim() || `sec_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
			features: Array.isArray(features) ? features : [],
			defaultPrice: Number(defaultPrice) || 0,
			desc: desc || description || '',
			description: description || desc || '',
			updatedAt: new Date().toISOString(),
		};

		const db = await connectPortalDb();
		if (db) {
			const existing = await db.collection('apps').findOne({ id: appRecord.id });
			if (existing && existing.id !== originalId) {
				return NextResponse.json({ error: 'An app with this name/identifier already exists' }, { status: 400, headers: CORS_HEADERS });
			}

			if (originalId) {
				await db.collection('apps').updateOne({ id: originalId }, { $set: appRecord });
			} else {
				await db.collection('apps').updateOne({ id: appRecord.id }, { $set: appRecord }, { upsert: true });
			}

			await db.collection('audit_logs').insertOne({
				id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: `Saved micro-app configuration: ${appRecord.name}`,
				actor: 'SuperAdmin',
				level: 'info',
				details: { appId: appRecord.id, url: appRecord.url, originalId },
				timestamp: new Date().toISOString(),
			});
		}

		return NextResponse.json(appRecord, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function PATCH(req) {
	try {
		const body = await req.json().catch(() => ({}));
		const { appId, featureId, newCreditCost, newName, newDesc } = body;

		if (!appId || !featureId || newCreditCost === undefined) {
			return NextResponse.json(
				{ error: 'appId, featureId, and newCreditCost are required' },
				{ status: 400, headers: CORS_HEADERS },
			);
		}

		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json({ error: 'Database offline' }, { status: 503, headers: CORS_HEADERS });
		}

		const app = await db.collection('apps').findOne({ id: appId });
		if (!app) {
			return NextResponse.json({ error: `App ${appId} not found` }, { status: 404, headers: CORS_HEADERS });
		}

		const updatedFeatures = (app.features || []).map((f) => {
			if (f.id === featureId) {
				return {
					...f,
					creditCost: Number(newCreditCost),
					name: newName || f.name,
					desc: newDesc || f.desc,
				};
			}
			return f;
		});

		await db
			.collection('apps')
			.updateOne({ id: appId }, { $set: { features: updatedFeatures, updatedAt: new Date().toISOString() } });

		await db.collection('audit_logs').insertOne({
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			action: `Updated feature pricing: ${app.name} -> ${featureId} to $${newCreditCost}/mo`,
			actor: 'SuperAdmin',
			level: 'info',
			details: { appId, featureId, newCreditCost },
			timestamp: new Date().toISOString(),
		});

		return NextResponse.json({ success: true, appId, features: updatedFeatures }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function DELETE(req) {
	try {
		const { searchParams } = new URL(req.url);
		const id = searchParams.get('id');

		if (!id) {
			return NextResponse.json({ error: 'App ID required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectPortalDb();
		if (db) {
			await db.collection('apps').deleteOne({ id });

			await db.collection('audit_logs').insertOne({
				id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: `Removed micro-app: ${id}`,
				actor: 'SuperAdmin',
				level: 'danger',
				details: { appId: id },
				timestamp: new Date().toISOString(),
			});
		}

		return NextResponse.json({ success: true, id }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
