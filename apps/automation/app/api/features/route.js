import { NextResponse } from 'next/server';
import { connectAutomationDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const DEFAULT_FEATURES = [
	{
		"id": "triggers",
		"name": "Real-Time Event Triggers",
		"creditCost": 45,
		"desc": "Custom trigger rules on order creation and inventory low",
		"icon": "Zap",
		"category": "DevOps"
	},
	{
		"id": "notifications",
		"name": "SMS & WhatsApp Gateway",
		"creditCost": 50,
		"desc": "Direct transactional dispatch via third-party providers",
		"icon": "MessageCircle",
		"category": "Comms"
	},
	{
		"id": "webhooks_out",
		"name": "Custom Outbound Webhooks",
		"creditCost": 25,
		"desc": "Signed payload dispatch with retry queues",
		"icon": "Webhook",
		"category": "DevOps"
	}
];

async function getLiveFeatures(db) {
	let portalFeatures = DEFAULT_FEATURES;
	try {
		const portalUrl = process.env.PORTAL_URL || 'http://localhost:3000';
		// Use dynamic fetch to avoid stale cache on pricing
		const res = await fetch(`${portalUrl}/api/apps`, { cache: 'no-store' });
		if (res.ok) {
			const apps = await res.json();
			const analyticsApp = apps.find((a) => a.id === 'automation');
			if (analyticsApp && Array.isArray(analyticsApp.features) && analyticsApp.features.length > 0) {
				// Merge portal data with our local UI defaults
				portalFeatures = analyticsApp.features.map((pf) => {
					const localFeat = DEFAULT_FEATURES.find((df) => df.id === pf.id) || {};
					return {
						...localFeat,
						...pf,
					};
				});
			}
		}
	} catch (err) {
		console.warn('Failed to fetch live feature pricing from Portal:', err.message);
	}

	// Merge with local app-level overrides if DB is available
	if (db) {
		try {
			const overrides = await db.collection('app_pricing_overrides').find({}).toArray();
			if (overrides && overrides.length > 0) {
				portalFeatures = portalFeatures.map(f => {
					const override = overrides.find(o => o.featureId === f.id);
					return override ? { ...f, ...override } : f;
				});
			}
		} catch (err) {
			console.warn('Failed to fetch local feature overrides:', err.message);
		}
	}
	return portalFeatures;
}

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const siteId = searchParams.get('siteId');

		const db = await connectAutomationDb();
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

		const db = await connectAutomationDb();
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

		const db = await connectAutomationDb();
		if (!db) {
			return NextResponse.json({ error: 'Database unavailable' }, { status: 503, headers: CORS_HEADERS });
		}

		const updates = {};
		if (newCreditCost !== undefined) updates.creditCost = Number(newCreditCost);
		if (newName !== undefined) updates.name = newName;
		if (newDesc !== undefined) updates.desc = newDesc;
		updates.updatedAt = new Date().toISOString();

		await db.collection('app_pricing_overrides').updateOne(
			{ featureId },
			{ $set: updates },
			{ upsert: true }
		);

		return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
