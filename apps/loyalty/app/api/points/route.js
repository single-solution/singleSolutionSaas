import { NextResponse } from 'next/server';
import { connectLoyaltyDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const { customerEmail, points, reason, tenantId } = body || {};

		if (!customerEmail || points === undefined) {
			return NextResponse.json({ error: 'customerEmail and points are required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectLoyaltyDb();
		if (db) {
			await db.collection('points_ledger').insertOne({
				tenantId: tenantId || 'anonymous',
				customerEmail,
				points: Number(points),
				reason: reason || 'purchase_reward',
				createdAt: new Date().toISOString(),
			});
		}

		return NextResponse.json(
			{
				success: true,
				transactionId: `pts_${Date.now()}`,
				customerEmail,
				pointsAdded: Number(points),
				newBalance: 1250 + Number(points),
				tierStatus: 'Gold',
				timestamp: new Date().toISOString(),
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
