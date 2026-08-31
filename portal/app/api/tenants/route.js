import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../lib/db.js';
import { hashPassword } from '../../../lib/auth.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET() {
	try {
		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json([], { headers: CORS_HEADERS });
		}
		const tenants = await db.collection('tenants').find({}).sort({ createdAt: -1 }).toArray();
		return NextResponse.json(
			(tenants || []).map(({ _id, password: _pwd, ...t }) => ({
				...t,
				websites:
					Array.isArray(t.websites) && t.websites.length > 0
						? t.websites
						: [
								{
									id: `site_${t.id || 'default'}`,
									name: t.name,
									domain: t.domain,
									status: t.status || 'active',
									subscriptions: t.subscriptions || {},
									createdAt: t.createdAt || new Date().toISOString(),
								},
							],
			})),
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json({ error: 'Database connection unavailable' }, { status: 503, headers: CORS_HEADERS });
		}

		// Single tenant creation mode
		const {
			name,
			domain,
			email,
			contactEmail,
			password,
			plan = 'pro',
			initialCredits = 200,
			secretKey,
			apiKey,
			subscriptions = {},
			websites,
		} = body;

		if (!name || !domain) {
			return NextResponse.json({ error: 'Store Name and Domain are required' }, { status: 400, headers: CORS_HEADERS });
		}

		const cleanDomain = domain
			.trim()
			.toLowerCase()
			.replace(/^https?:\/\//, '')
			.replace(/\/$/, '');
		const slug = name
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '_')
			.substring(0, 15);

		// Check if domain or email already exists
		const existing = await db.collection('tenants').findOne({
			$or: [{ domain: cleanDomain }, { email: email?.trim().toLowerCase() }],
		});
		if (existing) {
			return NextResponse.json(
				{ error: 'A merchant store with this domain or email already exists' },
				{ status: 409, headers: CORS_HEADERS },
			);
		}

		const generatedSecret = secretKey?.trim() || `sk_live_${slug}_${Math.random().toString(36).substring(2, 10)}`;
		const tenantPassword = password ? hashPassword(password) : hashPassword(generatedSecret);

		const tenantId = body.id || `tnt_${slug}_${Date.now().toString().slice(-4)}`;

		const defaultWebsites =
			Array.isArray(websites) && websites.length > 0
				? websites
				: [
						{
							id: `site_${Date.now().toString().slice(-4)}`,
							name: `${name.trim()} (Primary)`,
							domain: cleanDomain,
							status: 'active',
							subscriptions,
							createdAt: new Date().toISOString(),
						},
					];

		const tenantRecord = {
			id: tenantId,
			name: name.trim(),
			domain: cleanDomain,
			email: (email || `admin@${cleanDomain}`).trim().toLowerCase(),
			contactEmail: (contactEmail || email || `support@${cleanDomain}`).trim().toLowerCase(),
			password: tenantPassword,
			status: 'active',
			plan,
			creditsBalance: Number(initialCredits) || 0,
			secretKey: generatedSecret,
			apiKey: apiKey?.trim() || `ss_live_${slug}_${Math.random().toString(36).substring(2, 10)}`,
			subscriptions,
			websites: defaultWebsites,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		await db.collection('tenants').insertOne(tenantRecord);

		await db.collection('audit_logs').insertOne({
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			action: `Provisioned new merchant store: ${tenantRecord.name}`,
			actor: body.createdBy || 'SuperAdmin',
			level: 'success',
			details: { tenantId: tenantRecord.id, domain: tenantRecord.domain, plan: tenantRecord.plan },
			timestamp: new Date().toISOString(),
		});

		const { _id, password: _p, ...cleanResult } = tenantRecord;
		return NextResponse.json(cleanResult, { status: 201, headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
