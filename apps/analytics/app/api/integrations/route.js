import { NextResponse } from 'next/server';
import { connectAnalyticsDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const siteId = searchParams.get('siteId');

		if (!siteId) {
			return NextResponse.json({ error: 'siteId required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectAnalyticsDb();
		if (db) {
			const doc = await db.collection('store_integrations').findOne({ storeId: siteId });
			return NextResponse.json(doc || { storeId: siteId, metaCapi: {}, ga4: {}, webhooks: {} }, { headers: CORS_HEADERS });
		}

		return NextResponse.json({ storeId: siteId, metaCapi: {}, ga4: {}, webhooks: {} }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const { siteId, metaCapi, ga4, webhooks } = body || {};

		if (!siteId) {
			return NextResponse.json({ error: 'siteId required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectAnalyticsDb();
		if (db) {
			await db
				.collection('store_integrations')
				.updateOne(
					{ storeId: siteId },
					{ $set: { storeId: siteId, metaCapi, ga4, webhooks, updatedAt: new Date().toISOString() } },
					{ upsert: true },
				);
		}

		return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
