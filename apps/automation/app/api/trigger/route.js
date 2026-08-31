import { NextResponse } from 'next/server';
import { connectAutomationDb } from '../../../lib/db.js';

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
		const { event, payload, tenantId } = body || {};

		if (!event) {
			return NextResponse.json({ error: 'event is required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectAutomationDb();
		if (db) {
			await db.collection('executions').insertOne({
				tenantId: tenantId || 'anonymous',
				event,
				payload: payload || {},
				executedAt: new Date().toISOString(),
			});
		}

		return NextResponse.json(
			{
				success: true,
				executionId: `exec_${Date.now()}`,
				event,
				status: 'completed',
				actionsFired: 2,
				timestamp: new Date().toISOString(),
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
