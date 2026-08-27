// Vercel Serverless Function: POST /api/audit
export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return res.status(405).json({ error: 'Method not allowed' });
	}

	const { url } = req.body || {};
	if (!url) {
		return res.status(400).json({ error: 'url is required' });
	}

	return res.status(200).json({
		success: true,
		url,
		score: 95,
		checks: {
			hasTitle: true,
			hasMetaDesc: true,
			hasCanonical: true,
			mobileFriendly: true,
		},
		analyzedAt: new Date().toISOString(),
	});
}
