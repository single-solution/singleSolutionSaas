import { NextResponse } from 'next/server';
import { verifySSOToken } from '../../../../../../shared/ui/auth/ssoHandshake';
import { connectChatbotDb } from '../../../../lib/db';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function POST(req) {
	try {
		const { token, expectedProductId } = await req.json().catch(() => ({}));

		if (!token) {
			return NextResponse.json({ error: 'Missing token' }, { status: 400, headers: CORS_HEADERS });
		}

		// Verify using the local process.env.SSO_SECRET (which is loaded implicitly by verifySSOToken)
		const verification = verifySSOToken(token, { expectedProductId });

		if (!verification.valid) {
			return NextResponse.json({ error: verification.error }, { status: 401, headers: CORS_HEADERS });
		}

		const session = verification.session;

		// 1. Establish permanent connection
		const db = await connectChatbotDb();
		if (db) {
			await db.collection('portal_connections').updateOne(
				{ portalUrl: session.portalUrl },
				{
					$set: {
						portalUrl: session.portalUrl,
						adminId: session.tenantId,
						adminName: session.tenantName,
						role: session.role,
						lastHandshake: new Date().toISOString(),
					},
				},
				{ upsert: true },
			);
		}

		return NextResponse.json({ success: true, message: 'Cryptographic handshake accepted.' }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: 'Internal handshake error' }, { status: 500, headers: CORS_HEADERS });
	}
}
