import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../../lib/db.js';
import { verifyPassword, createSessionToken, buildSessionCookie } from '../../../../lib/auth.js';

export async function POST(req) {
	try {
		const body = await req.json().catch(() => ({}));
		const { email, password, role = 'admin' } = body;

		if (!email || !password) {
			return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
		}

		const cleanEmail = email.trim().toLowerCase();
		const db = await connectPortalDb();

		if (!db) {
			return NextResponse.json({ error: 'Database connection offline. Please check MongoDB service.' }, { status: 503 });
		}

		if (role === 'admin') {
			const adminCount = await db.collection('admin_users').countDocuments();
			if (adminCount === 0) {
				return NextResponse.json(
					{ error: 'No SuperAdmin account configured. Please complete initial setup.', needsSetup: true },
					{ status: 404 },
				);
			}

			const adminUser = await db.collection('admin_users').findOne({ email: cleanEmail });
			if (!adminUser) {
				return NextResponse.json({ error: 'Invalid SuperAdmin email or password' }, { status: 401 });
			}

			const isValid = verifyPassword(password, adminUser.password);
			if (!isValid) {
				return NextResponse.json({ error: 'Invalid SuperAdmin email or password' }, { status: 401 });
			}

			const userPayload = {
				id: adminUser.id || `adm_${Date.now()}`,
				name: adminUser.name,
				email: adminUser.email,
				role: 'admin',
				orgName: adminUser.orgName || 'SingleSolution Platform',
			};

			const token = createSessionToken(userPayload);
			const cookie = buildSessionCookie(token);

			await db.collection('audit_logs').insertOne({
				id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: `SuperAdmin signed in: ${adminUser.email}`,
				actor: adminUser.name,
				level: 'info',
				details: { ip: req.headers.get('x-forwarded-for') || 'localhost' },
				timestamp: new Date().toISOString(),
			});

			return new NextResponse(JSON.stringify(userPayload), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Set-Cookie': cookie,
				},
			});
		} else {
			// Merchant Store Login (Find by store email or store domain)
			const cleanDomain = cleanEmail.replace(/^https?:\/\//, '').replace(/\/$/, '');
			const tenant = await db.collection('tenants').findOne({
				$or: [{ email: cleanEmail }, { contactEmail: cleanEmail }, { domain: cleanDomain }, { id: cleanEmail }],
			});

			if (!tenant) {
				return NextResponse.json({ error: 'Merchant store not found for this email or domain' }, { status: 401 });
			}

			if (tenant.status === 'suspended') {
				return NextResponse.json(
					{ error: 'Merchant account is suspended. Please contact platform administrator.' },
					{ status: 403 },
				);
			}

			const validSecret = tenant.password || tenant.secretKey;
			const isPasswordValid = tenant.password ? verifyPassword(password, tenant.password) : false;
			const isSecretValid = tenant.secretKey
				? verifyPassword(password, tenant.secretKey) || password === tenant.secretKey
				: false;

			if (!isPasswordValid && !isSecretValid) {
				return NextResponse.json({ error: 'Invalid merchant password or secret key' }, { status: 401 });
			}

			const userPayload = {
				id: tenant.id,
				name: tenant.name,
				email: tenant.email || tenant.contactEmail || cleanEmail,
				domain: tenant.domain,
				role: 'merchant',
				status: tenant.status || 'active',
				creditsBalance: tenant.creditsBalance || 0,
				subscriptions: tenant.subscriptions || {},
				websites: Array.isArray(tenant.websites) ? tenant.websites : [],
				apiKey: tenant.apiKey || '',
			};

			const token = createSessionToken(userPayload);
			const cookie = buildSessionCookie(token);

			await db.collection('audit_logs').insertOne({
				id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: `Merchant signed in: ${tenant.name} (${tenant.domain})`,
				actor: tenant.name,
				level: 'info',
				details: { tenantId: tenant.id, domain: tenant.domain },
				timestamp: new Date().toISOString(),
			});

			return new NextResponse(JSON.stringify(userPayload), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					'Set-Cookie': cookie,
				},
			});
		}
	} catch (err) {
		return NextResponse.json({ error: err.message || 'Authentication error' }, { status: 500 });
	}
}
