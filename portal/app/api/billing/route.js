import { NextResponse } from 'next/server';
import { connectPortalDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const EMPTY_LEDGER = {
	id: 'primary_ledger',
	depositRequests: [],
	creditTransactions: [],
	bankConfig: {
		bankName: '',
		accountTitle: '',
		accountNumber: '',
		iban: '',
		branch: '',
		instructions: '',
	},
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

export async function GET() {
	try {
		const db = await connectPortalDb();
		if (db) {
			const billing = await db.collection('billing_ledger').findOne({ id: 'primary_ledger' });
			if (billing) {
				const { _id, ...clean } = billing;
				return NextResponse.json(clean, { headers: CORS_HEADERS });
			}
		}
		return NextResponse.json(EMPTY_LEDGER, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ ...EMPTY_LEDGER, error: err.message }, { headers: CORS_HEADERS });
	}
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const { action, depositRequests, creditTransactions, bankConfig, requestId, tenantId, amount, reason, adminName } =
			body || {};

		const db = await connectPortalDb();
		if (!db) {
			return NextResponse.json({ error: 'Database unavailable' }, { status: 503, headers: CORS_HEADERS });
		}

		// Handle specific actions if provided
		if (action === 'reject_deposit' && requestId) {
			const ledger = (await db.collection('billing_ledger').findOne({ id: 'primary_ledger' })) || EMPTY_LEDGER;
			const updatedRequests = (ledger.depositRequests || []).map((req) =>
				req.id === requestId
					? {
							...req,
							status: 'rejected',
							rejectionReason: reason || 'Receipt verification could not be confirmed.',
							rejectedAt: new Date().toISOString(),
							rejectedBy: adminName || 'SuperAdmin',
						}
					: req,
			);

			await db
				.collection('billing_ledger')
				.updateOne(
					{ id: 'primary_ledger' },
					{ $set: { depositRequests: updatedRequests, updatedAt: new Date().toISOString() } },
					{ upsert: true },
				);

			await db.collection('audit_logs').insertOne({
				id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: `Rejected deposit request ${requestId} (${reason || 'Unverified'})`,
				actor: adminName || 'SuperAdmin',
				level: 'danger',
				details: { requestId, tenantId, reason },
				timestamp: new Date().toISOString(),
			});

			return NextResponse.json({ success: true, depositRequests: updatedRequests }, { headers: CORS_HEADERS });
		}

		if (action === 'grant_credits' && tenantId && amount) {
			const tenant = await db.collection('tenants').findOne({ id: tenantId });
			const currentBalance = Number(tenant?.creditsBalance) || 0;
			const newBalance = currentBalance + Number(amount);

			await db
				.collection('tenants')
				.updateOne({ id: tenantId }, { $set: { creditsBalance: newBalance, updatedAt: new Date().toISOString() } });

			const ledger = (await db.collection('billing_ledger').findOne({ id: 'primary_ledger' })) || EMPTY_LEDGER;
			const newTx = {
				id: `TX-${Date.now().toString().slice(-5)}`,
				tenantId,
				amount: Number(amount),
				balanceAfter: newBalance,
				type: Number(amount) >= 0 ? 'credit_grant' : 'debit_charge',
				method: 'Administrative Adjustment',
				reference: reason || 'Manual Admin Credit Adjustment',
				timestamp: new Date().toISOString(),
			};
			const updatedTxs = [newTx, ...(ledger.creditTransactions || [])];

			await db
				.collection('billing_ledger')
				.updateOne(
					{ id: 'primary_ledger' },
					{ $set: { creditTransactions: updatedTxs, updatedAt: new Date().toISOString() } },
					{ upsert: true },
				);

			await db.collection('audit_logs').insertOne({
				id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
				action: `Admin adjusted credits ($${amount}) for tenant ${tenant?.name || tenantId}`,
				actor: adminName || 'SuperAdmin',
				level: 'success',
				details: { tenantId, amount, newBalance, reason },
				timestamp: new Date().toISOString(),
			});

			return NextResponse.json({ success: true, newBalance, transaction: newTx }, { headers: CORS_HEADERS });
		}

		// Full ledger sync mode
		const updateDoc = {
			id: 'primary_ledger',
			updatedAt: new Date().toISOString(),
		};
		if (depositRequests !== undefined) updateDoc.depositRequests = depositRequests;
		if (creditTransactions !== undefined) updateDoc.creditTransactions = creditTransactions;
		if (bankConfig !== undefined) updateDoc.bankConfig = bankConfig;

		await db.collection('billing_ledger').updateOne({ id: 'primary_ledger' }, { $set: updateDoc }, { upsert: true });

		return NextResponse.json({ success: true }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
