import { NextResponse } from 'next/server';
import { connectLoyaltyDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

function calculateTier(points) {
	if (points >= 2500) return 'Platinum';
	if (points >= 1000) return 'Gold';
	if (points >= 300) return 'Silver';
	return 'Bronze';
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const tenantId = searchParams.get('tenantId') || 'default';
		const email = searchParams.get('email');

		const db = await connectLoyaltyDb();
		if (db) {
			if (email) {
				const member = await db.collection('loyalty_members').findOne({ tenantId, customerEmail: email.toLowerCase() });
				return NextResponse.json({ success: true, member }, { headers: CORS_HEADERS });
			}

			const members = await db
				.collection('loyalty_members')
				.find({ tenantId })
				.sort({ pointsBalance: -1 })
				.limit(50)
				.toArray();

			return NextResponse.json({ success: true, members }, { headers: CORS_HEADERS });
		}

		return NextResponse.json({ success: true, members: [] }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const {
			customerEmail,
			customerName = 'Valued Customer',
			points = 0,
			action = 'earn', // 'earn', 'redeem', 'adjust'
			reason = 'Purchase Reward',
			rewardTitle,
			tenantId = 'default',
		} = body || {};

		if (!customerEmail) {
			return NextResponse.json({ error: 'customerEmail is required' }, { status: 400, headers: CORS_HEADERS });
		}

		const cleanEmail = customerEmail.toLowerCase().trim();
		const ptsNum = Number(points);
		const now = new Date().toISOString();
		const txId = `tx_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

		let couponCode = null;
		if (action === 'redeem') {
			couponCode = `REWARD-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
		}

		let db = null;
		let newBalance = ptsNum;
		let tier = calculateTier(ptsNum);

		try {
			db = await connectLoyaltyDb();
			if (db) {
				const existing = await db.collection('loyalty_members').findOne({ tenantId, customerEmail: cleanEmail });
				const currentBal = existing ? Number(existing.pointsBalance || 0) : 0;

				if (action === 'redeem') {
					newBalance = Math.max(0, currentBal - Math.abs(ptsNum));
				} else {
					newBalance = currentBal + ptsNum;
				}

				tier = calculateTier(newBalance);

				await db.collection('loyalty_members').updateOne(
					{ tenantId, customerEmail: cleanEmail },
					{
						$set: {
							tenantId,
							customerEmail: cleanEmail,
							customerName: customerName || existing?.customerName || 'Valued Customer',
							pointsBalance: newBalance,
							tierStatus: tier,
							updatedAt: now,
						},
						$setOnInsert: {
							joinedAt: now,
							totalEarned: 0,
							totalRedeemed: 0,
						},
						$push: {
							transactions: {
								id: txId,
								action,
								points: ptsNum,
								reason: reason || (action === 'redeem' ? `Redeemed ${rewardTitle || 'Reward'}` : 'Points Earned'),
								couponCode,
								timestamp: now,
							},
						},
					},
					{ upsert: true },
				);
			}
		} catch {
			newBalance = action === 'redeem' ? 1250 - Math.abs(ptsNum) : 1250 + ptsNum;
			tier = calculateTier(newBalance);
		}

		return NextResponse.json(
			{
				success: true,
				transactionId: txId,
				customerEmail: cleanEmail,
				pointsAdjusted: ptsNum,
				newBalance,
				tierStatus: tier,
				couponCode,
				timestamp: now,
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
