// Vercel Serverless Function: POST /api/chat
export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return res.status(405).json({ error: 'Method not allowed' });
	}

	const { message, tenantId, persona } = req.body || {};
	if (!message) {
		return res.status(400).json({ error: 'Message is required' });
	}

	// Simulated AI response logic
	const reply = `[${persona || 'AI Assistant'}] Received inquiry: "${message}". Processed for tenant ${tenantId || 'anonymous'}.`;

	return res.status(200).json({
		success: true,
		reply,
		tokensUsed: 42,
		timestamp: new Date().toISOString(),
	});
}
