import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const level = searchParams.get('level');
		const actor = searchParams.get('actor');
		const limit = Math.min(Number(searchParams.get('limit')) || 100, 500);

		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json([], { headers: CORS_HEADERS });
		}

		const query = {};
		if (level && level !== 'all') query.level = level;
		if (actor) {
			const safeActor = String(actor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			query.actor = { $regex: safeActor, $options: 'i' };
		}

		const logs = await db.collection('audit_logs').find(query).sort({ timestamp: -1 }).limit(limit).toArray();

		return NextResponse.json(
			(logs || []).map(({ _id, ...l }) => l),
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const { action, actor = 'SuperAdmin', level = 'info', details = {} } = body;

		if (!action) {
			return NextResponse.json({ error: 'Action is required' }, { status: 400, headers: CORS_HEADERS });
		}

		const newLog = {
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
			action: action.trim(),
			actor: actor.trim(),
			level,
			details,
			timestamp: new Date().toISOString(),
		};

		const db = await connectPortalDb();
		if (db) {
			await db.collection('audit_logs').insertOne(newLog);
		}

		return NextResponse.json(newLog, { status: 201, headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function DELETE() {
	try {
		const db = await connectPortalDb();
		if (db) {
			await db.collection('audit_logs').deleteMany({});
		}
		return NextResponse.json({ success: true, message: 'Audit logs cleared.' }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
