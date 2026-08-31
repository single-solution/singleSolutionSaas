import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEFAULT_SETTINGS = {
	id: 'cluster_config',
	platformName: 'SingleSolution Multi-Tenant Cloud',
	supportEmail: 'support@singlesolution.io',
	maintenanceMode: false,
	bankDetails: {
		bankName: 'Meezan Bank Ltd',
		accountTitle: 'Single Solution Technologies (Pvt) Ltd',
		accountNumber: '02010108920192',
		iban: 'PK45MEZN0002010108920192',
		branch: 'DHA Phase 5 Branch, Lahore',
		instructions: 'Please include your Store Domain or Tenant ID as the payment reference.',
	},
	security: {
		ssoTokenExpiryMinutes: 10,
		enforceHttps: false,
		allowMerchantKeyRotation: true,
	},
	updatedAt: new Date().toISOString(),
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET() {
	try {
		const db = await connectPortalDb();
		if (db) {
			const settings = await db.collection('cluster_settings').findOne({ id: 'cluster_config' });
			if (settings) {
				const { _id, ...clean } = settings;
				return NextResponse.json(clean, { headers: CORS_HEADERS });
			}
		}
		return NextResponse.json(DEFAULT_SETTINGS, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ ...DEFAULT_SETTINGS, error: err.message }, { headers: CORS_HEADERS });
	}
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const db = await connectPortalDb();

		const updatedSettings = {
			...DEFAULT_SETTINGS,
			...body,
			id: 'cluster_config',
			updatedAt: new Date().toISOString(),
		};

		if (db) {
			await db.collection('cluster_settings').updateOne({ id: 'cluster_config' }, { $set: updatedSettings }, { upsert: true });

			await db.collection('audit_logs').insertOne({
				id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: 'Updated platform cluster settings',
				actor: body.updatedBy || 'SuperAdmin',
				level: 'info',
				details: { bankName: updatedSettings.bankDetails?.bankName },
				timestamp: new Date().toISOString(),
			});
		}

		return NextResponse.json(updatedSettings, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
