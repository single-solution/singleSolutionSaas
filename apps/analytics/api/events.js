// Vercel Serverless Function: POST /api/events
export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return res.status(405).json({ error: 'Method not allowed' });
	}

	const { eventType, path, tenantId, payload } = req.body || {};
	if (!eventType) {
		return res.status(400).json({ error: 'eventType is required' });
	}

	return res.status(200).json({
		success: true,
		eventId: `evt_${Date.now()}`,
		tenantId: tenantId || 'anonymous',
		eventType,
		path: path || '/',
		ingestedAt: new Date().toISOString(),
	});
}
