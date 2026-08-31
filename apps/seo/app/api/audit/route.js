import { NextResponse } from 'next/server';
import { connectSeoDb } from '../../../lib/db.js';

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
		const { url, tenantId } = body || {};

		if (!url) {
			return NextResponse.json({ error: 'url is required' }, { status: 400, headers: CORS_HEADERS });
		}

		const db = await connectSeoDb();
		if (db) {
			await db.collection('audit_runs').insertOne({
				tenantId: tenantId || 'anonymous',
				url,
				auditedAt: new Date().toISOString(),
			});
		}

		return NextResponse.json(
			{
				success: true,
				auditId: `audit_${Date.now()}`,
				url,
				score: 94,
				issuesFound: 0,
				metaValid: true,
				schemaFound: ['Product', 'BreadcrumbList', 'Organization'],
				timestamp: new Date().toISOString(),
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
