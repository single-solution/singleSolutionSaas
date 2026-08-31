import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../../lib/db.js';
import { hashPassword, createSessionToken, buildSessionCookie } from '../../../../lib/auth.js';

export async function POST(req) {
	try {
		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json({ error: 'Database connection offline' }, { status: 503 });
		}

		const count = await db.collection('admin_users').countDocuments();
		if (count > 0) {
			return NextResponse.json(
				{ error: 'SuperAdmin account is already configured. Registration is disabled.' },
				{ status: 403 },
			);
		}

		const body = await req.json().catch(() => ({}));
		const { name, email, password, orgName } = body;

		if (!email || !password || !name) {
			return NextResponse.json({ error: 'Name, email, and password are required' }, { status: 400 });
		}

		const cleanEmail = email.trim().toLowerCase();
		const hashedPassword = hashPassword(password);
		const adminUser = {
			id: `adm_${Date.now()}`,
			name: name.trim(),
			email: cleanEmail,
			password: hashedPassword,
			orgName: orgName?.trim() || 'SingleSolution Platform',
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		await db.collection('admin_users').insertOne(adminUser);

		// Record initial audit event
		await db.collection('audit_logs').insertOne({
			id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
			action: `SuperAdmin root account provisioned: ${cleanEmail}`,
			actor: name.trim(),
			level: 'success',
			details: { email: cleanEmail, orgName: adminUser.orgName },
			timestamp: new Date().toISOString(),
		});

		const userPayload = {
			id: adminUser.id,
			name: adminUser.name,
			email: adminUser.email,
			role: 'admin',
			orgName: adminUser.orgName,
		};

		const token = createSessionToken(userPayload);
		const cookie = buildSessionCookie(token);

		return new NextResponse(JSON.stringify(userPayload), {
			status: 201,
			headers: {
				'Content-Type': 'application/json',
				'Set-Cookie': cookie,
			},
		});
	} catch (err) {
		return NextResponse.json({ error: err.message || 'Setup failed' }, { status: 500 });
	}
}
