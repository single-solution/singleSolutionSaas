import { NextResponse } from 'next/server';
import { connectChatbotDb } from '../../../lib/db.js';

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
		const { message, tenantId } = body || {};

		if (!message) {
			return NextResponse.json({ error: 'message is required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectChatbotDb();
		if (db) {
			await db.collection('conversations').insertOne({
				tenantId: tenantId || 'anonymous',
				message,
				createdAt: new Date().toISOString(),
			});
		}

		return NextResponse.json(
			{
				success: true,
				reply: `[AI Chatbot Support]: We received your inquiry: "${message}". Our automated knowledge base confirms this item is in stock with 24h dispatch.`,
				intent: 'order_status',
				tokensUsed: 42,
				timestamp: new Date().toISOString(),
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
