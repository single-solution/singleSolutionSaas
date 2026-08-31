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

		return Response.json({
			hasAdmin,
			user: session || null,
		});
	} catch {
		return Response.json({ hasAdmin: false, user: null });
	}
}
