import { NextResponse } from 'next/server';
import { connectAnalyticsDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const DEFAULT_FEATURES = [
	{
		id: 'core_traffic',
		name: 'Real-Time Traffic Radar',
		creditCost: 30,
		desc: 'Live visitor counter, session graphs, device/OS & city geo breakdown',
		icon: 'Activity',
		category: 'Traffic',
	},
	{
		id: 'funnel_dropoff',
		name: '5-Stage Conversion Funnel',
		creditCost: 35,
		desc: 'Step-by-step buyer drop-off diagnostics & GMV attribution',
		icon: 'TrendingUp',
		category: 'E-Commerce',
	},
	{
		id: 'product_merch',
		name: 'Product Merchandising',
		creditCost: 30,
		desc: 'SKU velocity, hot sellers vs attention-needed catalog items',
		icon: 'ShoppingBag',
		category: 'E-Commerce',
	},
	{
		id: 'speed_insights',
		name: 'Speed & Core Web Vitals',
		creditCost: 25,
		desc: 'Real-device P75 scoring (LCP, CLS, INP, TTFB) & slowest URLs',
		icon: 'Zap',
		category: 'Performance',
	},
	{
		id: 'search_analytics',
		name: 'Search Query Intelligence',
		creditCost: 25,
		desc: 'Top catalog search terms & zero-result demand tracking',
		icon: 'Search',
		category: 'Intelligence',
	},
	{
		id: 'broken_links',
		name: '404 Broken Link Radar',
		creditCost: 15,
		desc: 'Broken page visits and incoming referral attribution',
		icon: 'AlertTriangle',
		category: 'Diagnostics',
	},
	{
		id: 'meta_capi',
		name: 'Meta Conversions API (CAPI)',
		creditCost: 30,
		desc: 'Server-side Facebook/Instagram tracking with test event codes',
		icon: 'Share2',
		category: 'Integrations',
	},
	{
		id: 'ga4_sync',
		name: 'Google Analytics 4 Protocol',
		creditCost: 20,
		desc: 'Direct server-to-server GA4 measurement dispatching',
		icon: 'BarChart2',
		category: 'Integrations',
	},
	{
		id: 'custom_webhooks',
		name: 'Real-Time Outbound Webhooks',
		creditCost: 25,
		desc: 'Instant webhook dispatches on orders, cart events, and spikes',
		icon: 'Webhook',
		category: 'Integrations',
	},
];

async function getLiveFeatures(db) {
	let features = [...DEFAULT_FEATURES];

	// Merge with local app-level overrides if DB is available
	if (db) {
		try {
			const overrides = await db.collection('app_pricing_overrides').find({}).toArray();
			if (overrides && overrides.length > 0) {
				features = features.map((f) => {
					const override = overrides.find((o) => o.featureId === f.id);
					return override ? { ...f, ...override } : f;
				});
			}
		} catch (err) {
			console.warn('Failed to fetch local feature overrides:', err.message);
		}
	}
	return features;
}

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const siteId = searchParams.get('siteId');

		const db = await connectAnalyticsDb();
		const liveFeatures = await getLiveFeatures(db);
		let enabledFeatures = liveFeatures.map((f) => f.id); // Default all if not customized

		if (db && siteId) {
			const storeDoc = await db.collection('store_features').findOne({ storeId: siteId });
			if (storeDoc && Array.isArray(storeDoc.features)) {
				enabledFeatures = storeDoc.features;
			}
		}

		const totalMonthlyCost = liveFeatures.reduce((sum, f) => {
			return enabledFeatures.includes(f.id) ? sum + f.creditCost : sum;
		}, 0);

		return NextResponse.json(
			{
				features: liveFeatures,
				enabledFeatures,
				totalMonthlyCost,
				siteId,
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const { siteId, featureId, action } = body;

		if (!siteId || !featureId) {
			return NextResponse.json({ error: 'siteId and featureId are required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectAnalyticsDb();
		if (!db) {
			return NextResponse.json({ error: 'Database unavailable' }, { status: 503, headers: CORS_HEADERS });
		}

		const liveFeatures = await getLiveFeatures(db);
		const storeDoc = await db.collection('store_features').findOne({ storeId: siteId });
		let currentFeatures = storeDoc?.features || liveFeatures.map((f) => f.id);

		if (action === 'enable') {
			if (!currentFeatures.includes(featureId)) {
				currentFeatures = [...currentFeatures, featureId];
			}
		} else if (action === 'disable') {
			currentFeatures = currentFeatures.filter((id) => id !== featureId);
		} else {
			// Toggle
			currentFeatures = currentFeatures.includes(featureId)
				? currentFeatures.filter((id) => id !== featureId)
				: [...currentFeatures, featureId];
		}

		await db.collection('store_features').updateOne(
			{ storeId: siteId },
			{
				$set: {
					storeId: siteId,
					features: currentFeatures,
					updatedAt: new Date().toISOString(),
				},
			},
			{ upsert: true },
		);

		const totalMonthlyCost = liveFeatures.reduce((sum, f) => {
			return currentFeatures.includes(f.id) ? sum + f.creditCost : sum;
		}, 0);

		return NextResponse.json(
			{
				success: true,
				enabledFeatures: currentFeatures,
				totalMonthlyCost,
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function PATCH(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const { featureId, newCreditCost, newName, newDesc } = body;

		if (!featureId) {
			return NextResponse.json({ error: 'featureId is required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectAnalyticsDb();
		if (!db) {
			return NextResponse.json({ error: 'Database unavailable' }, { status: 503, headers: CORS_HEADERS });
		}

		const updates = {};
		if (newCreditCost !== undefined) updates.creditCost = Number(newCreditCost);
		if (newName !== undefined) updates.name = newName;
		if (newDesc !== undefined) updates.desc = newDesc;
		updates.updatedAt = new Date().toISOString();

		await db.collection('app_pricing_overrides').updateOne({ featureId }, { $set: updates }, { upsert: true });

		return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
