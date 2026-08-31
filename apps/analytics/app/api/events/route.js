import { NextResponse } from 'next/server';
import { connectAnalyticsDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const {
			siteId,
			eventType,
			eventName,
			path,
			title,
			referrer,
			sessionId,
			visitorId,
			device,
			browser,
			os,
			city,
			durationMs,
			vitalMetric,
			vitalValue,
			vitalRating,
			eventData,
		} = body || {};

		const newEvent = {
			id: `ev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			storeId: siteId || 'anonymous_store',
			timestamp: new Date().toISOString(),
			eventType: eventType || 'page_view',
			eventName,
			path: path || '/',
			title: title || 'Storefront Page',
			referrer: referrer || 'Direct',
			sessionId: sessionId || `sess_${Date.now()}`,
			visitorId: visitorId || `vis_${Date.now()}`,
			device: device || 'Mobile Phone',
			browser: browser || 'Mobile Safari',
			os: os || 'iOS 18.0',
			city: city || 'Karachi, Sindh',
			durationMs: Number(durationMs) || 3500,
			vitalMetric,
			vitalValue,
			vitalRating,
			eventData,
		};

		const db = await connectAnalyticsDb();
		if (db) {
			await db.collection('telemetry_events').insertOne(newEvent);
		}

		return NextResponse.json({ success: true, eventId: newEvent.id, event: newEvent }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const siteId = searchParams.get('siteId');

		if (!siteId) {
			return NextResponse.json({ error: 'siteId query parameter is required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectAnalyticsDb();
		if (db) {
			const events = await db.collection('telemetry_events').find({ storeId: siteId }).sort({ _id: -1 }).limit(100).toArray();
			return NextResponse.json(events, { headers: CORS_HEADERS });
		}

		return NextResponse.json([], { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function DELETE(request) {
	try {
		const { searchParams } = new URL(request.url);
		const siteId = searchParams.get('siteId');

		const db = await connectAnalyticsDb();
		if (db && siteId) {
			await db.collection('telemetry_events').deleteMany({ storeId: siteId });
		}

		return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
