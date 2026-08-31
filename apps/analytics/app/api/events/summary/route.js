import { NextResponse } from 'next/server';
import { connectAnalyticsDb } from '../../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Site-ID',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const siteId =
			searchParams.get('siteId') ||
			searchParams.get('storeId') ||
			request.headers.get('x-site-id') ||
			request.headers.get('x-store-id');

		if (!siteId) {
			return NextResponse.json(
				{ error: 'siteId is required via query param ?siteId=... or header X-Site-ID' },
				{ status: 400, headers: CORS_HEADERS },
			);
		}

		const db = await connectAnalyticsDb();
		if (!db) {
			return NextResponse.json({ error: 'Database unavailable' }, { status: 503, headers: CORS_HEADERS });
		}

		// Fetch recent events for this store
		const events = await db.collection('telemetry_events').find({ storeId: siteId }).sort({ _id: -1 }).limit(500).toArray();

		// Calculate Real-Time Metrics
		const now = Date.now();
		const fiveMinsAgo = new Date(now - 5 * 60 * 1000).toISOString();
		const activeLiveVisitors = events.filter((e) => e.timestamp >= fiveMinsAgo).length;

		const totalPageViews = events.filter((e) => e.eventType === 'page_view' || !e.eventType).length;
		const totalCartAdds = events.filter((e) => e.eventType === 'add_to_cart' || e.eventName === 'add_to_cart').length;
		const purchaseEvents = events.filter(
			(e) => e.eventType === 'purchase' || e.eventName === 'order_completed' || e.eventName === 'purchase',
		);
		const totalPurchases = purchaseEvents.length;

		const totalRevenue = purchaseEvents.reduce((sum, e) => {
			const val = parseFloat(String(e.eventData?.total || e.eventData?.value || '0').replace(/[^0-9.]/g, '')) || 0;
			return sum + val;
		}, 0);

		// Top Visited Paths
		const pathCounts = {};
		events.forEach((e) => {
			const p = e.path || '/';
			pathCounts[p] = (pathCounts[p] || 0) + 1;
		});
		const topPages = Object.entries(pathCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([path, count]) => ({ path, views: count }));

		// Top Search Queries
		const searchEvents = events.filter((e) => e.eventType === 'search' || e.eventName === 'search_query');
		const searchCounts = {};
		searchEvents.forEach((e) => {
			const query = e.eventData?.query || e.title || 'unknown';
			searchCounts[query] = (searchCounts[query] || 0) + 1;
		});
		const topSearches = Object.entries(searchCounts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([query, count]) => ({ query, count }));

		return NextResponse.json(
			{
				siteId,
				timestamp: new Date().toISOString(),
				realtime: {
					activeLiveVisitors,
					windowMinutes: 5,
				},
				kpis: {
					totalPageViews,
					totalCartAdds,
					totalPurchases,
					totalRevenue: Math.round(totalRevenue * 100) / 100,
					conversionRate: totalPageViews > 0 ? `${((totalPurchases / totalPageViews) * 100).toFixed(2)}%` : '0%',
				},
				topPages,
				topSearches,
				recentEventsCount: events.length,
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
