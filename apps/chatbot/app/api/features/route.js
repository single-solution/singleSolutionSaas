import { NextResponse } from 'next/server';
import { connectChatbotDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const DEFAULT_FEATURES = [
	{
		id: 'conversations',
		name: 'AI Order Lookup & FAQ',
		creditCost: 60,
		desc: 'Automated natural language customer resolution',
		icon: 'Bot',
		category: 'CX',
	},
	{
		id: 'handoff',
		name: 'Human Live Agent Handoff',
		creditCost: 40,
		desc: 'Seamless escalation to store support operators',
		icon: 'UserCircle',
		category: 'CX',
	},
	{
		id: 'widget',
		name: 'Floating Storefront Widget',
		creditCost: 20,
		desc: 'Customizable branded chat widget snippet',
		icon: 'MessageSquare',
		category: 'CX',
	},
];

async function getLiveFeatures(db) {
	let portalFeatures = DEFAULT_FEATURES;
	try {
		let portalUrl = process.env.PORTAL_URL;
		if (!portalUrl && db) {
			try {
				const conn = await db.collection('portal_connections').findOne({}, { sort: { lastHandshake: -1 } });
				if (conn && conn.portalUrl) portalUrl = conn.portalUrl;
			} catch {}
		}
		if (!portalUrl) portalUrl = 'http://localhost:3000';
		// Use dynamic fetch to avoid stale cache on pricing with 2.5s timeout
		const res = await fetch(`${portalUrl}/api/apps`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
		if (res.ok) {
			const apps = await res.json();
			const analyticsApp = apps.find((a) => a.id === 'chatbot');
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
				portalFeatures = portalFeatures.map((f) => {
					const override = overrides.find((o) => o.featureId === f.id);
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

		const db = await connectChatbotDb();
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

		const db = await connectChatbotDb();
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

		const db = await connectChatbotDb();
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
