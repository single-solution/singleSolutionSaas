import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../../lib/db.js';

export async function POST(req) {
	try {
		const body = await req.json().catch(() => ({}));
		const { email, role = 'admin' } = body;

		if (!email) {
			return NextResponse.json({ error: 'Email or domain is required' }, { status: 400 });
		}

		const cleanEmail = email.trim().toLowerCase();
		const db = await connectPortalDb();

		if (!db) {
			return NextResponse.json({ error: 'Database connection unavailable' }, { status: 503 });
		}

		if (role === 'admin') {
			const admin = await db.collection('admin_users').findOne({ email: cleanEmail });
			if (!admin) {
				return NextResponse.json({
					success: true,
					message: 'If an account exists with this email, recovery guidance has been processed.',
					instructions:
						'For security, root SuperAdmin access can be reset directly on the host server using environment secrets or database CLI.',
				});
			}

			// Record audit log
			await db.collection('audit_logs').insertOne({
				id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: `Password reset requested for SuperAdmin: ${cleanEmail}`,
				actor: cleanEmail,
				level: 'warning',
				details: { role: 'admin' },
				timestamp: new Date().toISOString(),
			});

			return NextResponse.json({
				success: true,
				message: `Password reset request registered for ${admin.name}.`,
				instructions:
					'SuperAdmin credentials are cryptographically protected. You can update your password directly from the cluster console or by connecting to MongoDB.',
			});
		} else {
			// Merchant password lookup
			const cleanDomain = cleanEmail.replace(/^https?:\/\//, '').replace(/\/$/, '');
			const tenant = await db.collection('tenants').findOne({
				$or: [{ email: cleanEmail }, { contactEmail: cleanEmail }, { domain: cleanDomain }, { id: cleanEmail }],
			});

			if (!tenant) {
				return NextResponse.json({
					success: true,
					message: 'If a store exists for this email, recovery guidance has been processed.',
					instructions: 'Contact your platform SuperAdmin to reset your store password.',
				});
			}

			await db.collection('audit_logs').insertOne({
				id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: `Password reset requested for Merchant: ${tenant.name}`,
				actor: tenant.name,
				level: 'warning',
				details: { tenantId: tenant.id, domain: tenant.domain },
				timestamp: new Date().toISOString(),
			});

			return NextResponse.json({
				success: true,
				message: `Store found: ${tenant.name} (${tenant.domain})`,
				instructions: `Your store administrator password can be reset by the SuperAdmin in the "Store Tenants" management matrix, or you can sign in directly using your Private HMAC Secret Key.`,
			});
		}
	} catch (err) {
		return NextResponse.json({ error: err.message || 'Recovery request failed' }, { status: 500 });
	}
}
