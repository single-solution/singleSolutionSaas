import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function POST(request) {
	try {
		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json({ error: 'Database connection unavailable' }, { status: 503, headers: CORS_HEADERS });
		}

		// Fetch all active tenants and apps
		const tenants = await db.collection('tenants').find({ status: 'active' }).toArray();
		const apps = await db.collection('apps').find({}).toArray();

		if (!tenants || tenants.length === 0) {
			return NextResponse.json({ message: 'No active tenants to process.' }, { status: 200, headers: CORS_HEADERS });
		}

		let totalDeducted = 0;
		let tenantsProcessed = 0;
		const transactions = [];

		for (const tenant of tenants) {
			const websites =
				Array.isArray(tenant.websites) && tenant.websites.length > 0
					? tenant.websites
					: [{ subscriptions: tenant.subscriptions || {} }];

			let monthlyCost = 0;

			for (const site of websites) {
				const subs = site.subscriptions || {};
				apps.forEach((prod) => {
					const activeFeatureIds = subs[prod.id] || [];
					if (Array.isArray(prod.features)) {
						prod.features.forEach((feat) => {
							if (activeFeatureIds.includes(feat.id)) {
								monthlyCost += Number(feat.creditCost) || 0;
							}
						});
					}
				});
			}

			if (monthlyCost > 0) {
				// Calculate AWS-style hourly rate (720 hours per month)
				const hourlyCost = Math.round((monthlyCost / 720) * 10000) / 10000;

				const currentBalance = Number(tenant.creditsBalance) || 0;
				const newBalance = Math.round((currentBalance - hourlyCost) * 10000) / 10000;

				// Suspend if out of credits
				const newStatus = newBalance < 0 ? 'suspended' : tenant.status;

				await db.collection('tenants').updateOne(
					{ _id: tenant._id },
					{
						$set: {
							creditsBalance: newBalance,
							status: newStatus,
							updatedAt: new Date().toISOString(),
						},
					},
				);

				transactions.push({
					id: `TX-CRON-${Date.now().toString().slice(-4)}-${Math.random().toString(36).substring(2, 6)}`,
					tenantId: tenant.id,
					amount: -hourlyCost,
					balanceAfter: newBalance,
					type: 'debit_charge',
					method: 'Hourly Cron Deduction',
					reference: `Hourly usage for ${monthlyCost} credits/mo plan`,
					timestamp: new Date().toISOString(),
				});

				totalDeducted += hourlyCost;
				tenantsProcessed++;
			}
		}

		// Insert transactions in bulk
		if (transactions.length > 0) {
			await db.collection('credit_transactions').insertMany(transactions);

			await db.collection('audit_logs').insertOne({
				id: `log_cron_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: `Ran hourly billing engine. Processed ${tenantsProcessed} stores.`,
				actor: 'System',
				level: 'info',
				details: { tenantsProcessed, totalDeducted },
				timestamp: new Date().toISOString(),
			});
		}

		return NextResponse.json(
			{
				message: 'Hourly deduction simulated successfully',
				tenantsProcessed,
				totalDeducted,
			},
			{ status: 200, headers: CORS_HEADERS },
		);
	} catch (err) {
		console.error('Cron Deduct Error:', err);
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
