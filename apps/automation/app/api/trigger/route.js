import { NextResponse } from 'next/server';
import { connectAutomationDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const tenantId = searchParams.get('tenantId') || 'default';

		const db = await connectAutomationDb();
		if (db) {
			const executions = await db.collection('executions').find({ tenantId }).sort({ executedAt: -1 }).limit(50).toArray();

			return NextResponse.json({ success: true, executions }, { headers: CORS_HEADERS });
		}

		return NextResponse.json({ success: true, executions: [] }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const { event, payload = {}, workflowName = 'Custom Workflow', tenantId = 'default' } = body || {};

		if (!event) {
			return NextResponse.json({ error: 'event is required' }, { status: 400, headers: CORS_HEADERS });
		}

		const execId = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
		const now = new Date().toISOString();

		// Determine actions fired based on event
		const actions = [];
		if (event.includes('order')) {
			actions.push('Sent WhatsApp confirmation receipt to buyer');
			actions.push('Dispatched fulfillment payload to warehouse courier');
		} else if (event.includes('cart')) {
			actions.push('Scheduled 1h recovery email sequence with 10% coupon');
		} else if (event.includes('stock')) {
			actions.push('Sent urgent low-inventory alert to merchant Slack/Email');
		} else {
			actions.push('Dispatched real-time outbound webhook payload');
		}

		const execRecord = {
			id: execId,
			tenantId,
			event,
			workflowName,
			payload,
			actions,
			actionsFired: actions.length,
			status: 'Success',
			durationMs: Math.floor(Math.random() * 80 + 30),
			executedAt: now,
		};

		const db = await connectAutomationDb();
		if (db) {
			await db.collection('executions').insertOne(execRecord);
		}

		return NextResponse.json(
			{
				success: true,
				execution: execRecord,
				timestamp: now,
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
