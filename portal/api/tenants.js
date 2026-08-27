// Vercel Serverless Function: GET /api/tenants
export default async function handler(req, res) {
	const tenants = [
		{
			id: 'tnt_sisters_boutique',
			name: "Sister's Boutique",
			email: 'admin@sistersboutique.com',
			plan: 'pro',
			status: 'active',
			mrr: 450,
			products: ['chatbot', 'analytics', 'seo', 'loyalty'],
		},
		{
			id: 'tnt_chandni_traders',
			name: 'Chandni Traders',
			email: 'ops@chandnitraders.pk',
			plan: 'enterprise',
			status: 'active',
			mrr: 1200,
			products: ['chatbot', 'analytics', 'seo', 'automation', 'loyalty'],
		},
	];

	return res.status(200).json({
		success: true,
		total: tenants.length,
		tenants,
	});
}
