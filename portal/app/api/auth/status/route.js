import { connectPortalDb } from '../../../../lib/db.js';

export async function GET() {
	try {
		const db = await connectPortalDb();
		let hasAdmin = false;

		if (db) {
			const count = await db.collection('admin_users').countDocuments();
			hasAdmin = count > 0;
		}

		return Response.json({ hasAdmin });
	} catch {
		return Response.json({ hasAdmin: false });
	}
}
