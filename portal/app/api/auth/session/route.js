import { connectPortalDb } from '../../../../lib/db.js';
import { getSession } from '../../../../lib/auth.js';

export async function GET(req) {
	try {
		const db = await connectPortalDb();
		let hasAdmin = false;

		if (db) {
			const count = await db.collection('admin_users').countDocuments();
			hasAdmin = count > 0;
		}

		const session = getSession(req);
		let freshUser = session;

		if (db && session) {
			if (session.role === 'merchant') {
				const currentTenant = await db.collection('tenants').findOne({ id: session.id });
				if (currentTenant) {
					freshUser = {
						id: currentTenant.id,
						name: currentTenant.name,
						email: currentTenant.email || currentTenant.contactEmail || session.email,
						domain: currentTenant.domain,
						role: 'merchant',
						status: currentTenant.status || 'active',
						creditsBalance: currentTenant.creditsBalance || 0,
						subscriptions: currentTenant.subscriptions || {},
						websites: Array.isArray(currentTenant.websites) ? currentTenant.websites : [],
						apiKey: currentTenant.apiKey || '',
					};
				}
			} else if (session.role === 'admin') {
				const currentAdmin = await db.collection('admin_users').findOne({ email: session.email });
				if (currentAdmin) {
					freshUser = {
						id: currentAdmin.id || session.id,
						name: currentAdmin.name,
						email: currentAdmin.email,
						role: 'admin',
						orgName: currentAdmin.orgName || 'SingleSolution Platform',
					};
				}
			}
		}

		return Response.json({
			hasAdmin,
			user: freshUser || null,
		});
	} catch {
		return Response.json({ hasAdmin: false, user: null });
	}
}
