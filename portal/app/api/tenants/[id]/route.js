import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../../lib/db.js';
import { hashPassword } from '../../../../lib/auth.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET(request, { params }) {
	try {
		const { id } = params;
		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json({ error: 'Database unavailable' }, { status: 503, headers: CORS_HEADERS });
		}
		const tenant = await db.collection('tenants').findOne({ id });
		if (tenant) {
			const { _id, password: _p, ...clean } = tenant;
			return NextResponse.json(clean, { headers: CORS_HEADERS });
		}
		return NextResponse.json({ error: 'Tenant not found' }, { status: 404, headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function PATCH(request, { params }) {
	try {
		const { id } = params;
		const updates = await request.json().catch(() => ({}));
		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json({ error: 'Database unavailable' }, { status: 503, headers: CORS_HEADERS });
		}

		const cleanUpdates = { ...updates, updatedAt: new Date().toISOString() };
		delete cleanUpdates._id;
		delete cleanUpdates.id;

		let newTenantId = null;
		if (cleanUpdates.name) {
			const slug = cleanUpdates.name
				.toLowerCase()
				.replace(/[^a-z0-9]/g, '_')
				.substring(0, 20);
			newTenantId = `tnt_${slug}`;
			
			if (newTenantId !== id) {
				const existing = await db.collection('tenants').findOne({ id: newTenantId });
				if (existing) {
					return NextResponse.json({ error: 'A merchant store with this name already exists' }, { status: 409, headers: CORS_HEADERS });
				}
				cleanUpdates.id = newTenantId;
			}
		}

		// If a new password was supplied, hash it
		if (cleanUpdates.password) {
			cleanUpdates.password = hashPassword(cleanUpdates.password);
		}

		await db.collection('tenants').updateOne({ id }, { $set: cleanUpdates });

		const finalTenantId = newTenantId && newTenantId !== id ? newTenantId : id;

		const actionDescription =
			updates.apiKey || updates.secretKey
				? `Rotated credentials for tenant: ${finalTenantId}`
				: updates.status
					? `Changed status of ${finalTenantId} to ${updates.status}`
					: `Updated store profile for tenant: ${finalTenantId}`;

		await db.collection('audit_logs').insertOne({
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			action: actionDescription,
			actor: updates.updatedBy || 'SuperAdmin',
			level: 'info',
			details: { tenantId: finalTenantId, fields: Object.keys(cleanUpdates) },
			timestamp: new Date().toISOString(),
		});

		delete cleanUpdates.password;
		return NextResponse.json({ success: true, id: finalTenantId, updates: cleanUpdates }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function DELETE(request, { params }) {
	try {
		const { id } = params;
		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json({ error: 'Database unavailable' }, { status: 503, headers: CORS_HEADERS });
		}

		await db.collection('tenants').deleteOne({ id });

		await db.collection('audit_logs').insertOne({
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			action: `Deleted merchant tenant: ${id}`,
			actor: 'SuperAdmin',
			level: 'danger',
			details: { tenantId: id },
			timestamp: new Date().toISOString(),
		});

		return NextResponse.json({ success: true, id }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
