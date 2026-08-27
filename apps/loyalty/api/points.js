// Vercel Serverless Function: POST /api/points
export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return res.status(405).json({ error: 'Method not allowed' });
	}

	const { customerId, orderAmount, tenantId } = req.body || {};
	const amount = Number(orderAmount) || 0;
	const pointsEarned = Math.floor(amount * 2);

	return res.status(200).json({
		success: true,
		customerId: customerId || 'cust_guest',
		tenantId: tenantId || 'anonymous',
		pointsEarned,
		newBalance: 450 + pointsEarned,
		tier: 'Gold Tier',
		updatedAt: new Date().toISOString(),
	});
}
