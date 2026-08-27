// Vercel Serverless Function: POST /api/trigger
export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return res.status(405).json({ error: 'Method not allowed' });
	}

	const { triggerType, tenantId, payload } = req.body || {};
	if (!triggerType) {
		return res.status(400).json({ error: 'triggerType is required' });
	}

	return res.status(200).json({
		success: true,
		runId: `run_${Date.now()}`,
		tenantId: tenantId || 'anonymous',
		triggerType,
		executedSteps: 4,
		status: 'completed',
		latencyMs: 38,
		timestamp: new Date().toISOString(),
	});
}
