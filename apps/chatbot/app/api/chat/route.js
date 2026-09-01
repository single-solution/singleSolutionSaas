import { NextResponse } from 'next/server';
import { connectChatbotDb } from '../../../lib/db.js';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function OPTIONS() {
	return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}

function detectIntentAndReply(message, customFaqs = []) {
	const lower = (message || '').toLowerCase();

	// Check custom FAQs first
	for (const faq of customFaqs) {
		if (faq.question && lower.includes(faq.question.toLowerCase())) {
			return { intent: 'custom_faq', reply: faq.answer };
		}
		if (faq.keywords && Array.isArray(faq.keywords)) {
			if (faq.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
				return { intent: 'custom_faq', reply: faq.answer };
			}
		}
	}

	// 1. Order Tracking
	const orderMatch = message.match(/(?:order\s*#?|#)(\d{4,8})/i);
	if (orderMatch || lower.includes('where is my order') || lower.includes('track')) {
		const orderNum = orderMatch ? orderMatch[1] : '8924';
		return {
			intent: 'order_tracking',
			reply: `Order #${orderNum} has been processed and is in transit via Express Courier! Estimated delivery: Tomorrow by 5:00 PM. Tracking ref: EXP-${orderNum}-PK.`,
		};
	}

	// 2. Human Escalation / Speak to Agent
	if (
		lower.includes('human') ||
		lower.includes('agent') ||
		lower.includes('representative') ||
		lower.includes('speak to person') ||
		lower.includes('manager')
	) {
		return {
			intent: 'human_escalation',
			reply: `I have escalated your request to a live customer support representative. A team member will join this conversation shortly. Please stay on the line.`,
			status: 'Escalated',
		};
	}

	// 3. Return & Refund Policy
	if (lower.includes('return') || lower.includes('refund') || lower.includes('exchange')) {
		return {
			intent: 'returns_policy',
			reply: `We offer a 30-day hassle-free return and exchange policy on all unworn items with original tags. To initiate a return, visit your order confirmation email or reply with your Order #.`,
		};
	}

	// 4. Shipping & Delivery Times
	if (lower.includes('shipping') || lower.includes('delivery') || lower.includes('how long') || lower.includes('courier')) {
		return {
			intent: 'shipping_info',
			reply: `Standard delivery takes 2-4 business days ($4.99 or free on orders over $50). Express overnight delivery is available at checkout for $9.99.`,
		};
	}

	// 5. Discount Codes & Promotions
	if (
		lower.includes('discount') ||
		lower.includes('promo') ||
		lower.includes('coupon') ||
		lower.includes('sale') ||
		lower.includes('code')
	) {
		return {
			intent: 'discounts_promos',
			reply: `You can use promo code "WELCOME10" for 10% off your current order! Also check out our Loyalty Rewards bubble for instant point discounts.`,
		};
	}

	// 6. Sizing & Fit Assistance
	if (
		lower.includes('size') ||
		lower.includes('fit') ||
		lower.includes('measurement') ||
		lower.includes('large') ||
		lower.includes('small')
	) {
		return {
			intent: 'sizing_guide',
			reply: `Our sizing runs true to standard international sizes. If you are between sizes, we recommend ordering one size up for a relaxed fit. View our full size chart in the footer.`,
		};
	}

	// Default fallback response
	return {
		intent: 'general_inquiry',
		reply: `Thanks for reaching out! I'm your AI Shopping Assistant. I can help track your order, answer shipping/return questions, or recommend trending products. What can I help you with today?`,
	};
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const tenantId = searchParams.get('tenantId') || 'default';
		const conversationId = searchParams.get('conversationId');

		const db = await connectChatbotDb();
		if (db) {
			if (conversationId) {
				const convo = await db.collection('conversations').findOne({ id: conversationId });
				return NextResponse.json({ success: true, conversation: convo }, { headers: CORS_HEADERS });
			}

			const convos = await db.collection('conversations').find({ tenantId }).sort({ updatedAt: -1 }).limit(50).toArray();

			return NextResponse.json({ success: true, conversations: convos }, { headers: CORS_HEADERS });
		}

		return NextResponse.json({ success: true, conversations: [] }, { headers: CORS_HEADERS });
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}

export async function POST(request) {
	try {
		const body = await request.json().catch(() => ({}));
		const { message, tenantId = 'default', customerName = 'Guest Visitor', conversationId, customFaqs = [] } = body || {};

		if (!message) {
			return NextResponse.json({ error: 'message is required' }, { status: 400, headers: CORS_HEADERS });
		}

		const resolvedConvoId = conversationId || `conv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
		const now = new Date().toISOString();

		const analysis = detectIntentAndReply(message, customFaqs);
		const botReply = analysis.reply;
		const intent = analysis.intent;
		const convoStatus = analysis.status || 'Active';

		const userMsg = { sender: 'customer', text: message, timestamp: now };
		const botMsg = { sender: 'bot', text: botReply, intent, timestamp: new Date().toISOString() };

		const db = await connectChatbotDb();
		if (db) {
			await db.collection('conversations').updateOne(
				{ id: resolvedConvoId },
				{
					$set: {
						id: resolvedConvoId,
						tenantId,
						customerName,
						status: convoStatus,
						lastMessage: botReply,
						updatedAt: now,
					},
					$setOnInsert: {
						createdAt: now,
					},
					$push: {
						messages: { $each: [userMsg, botMsg] },
					},
				},
				{ upsert: true },
			);
		}

		return NextResponse.json(
			{
				success: true,
				conversationId: resolvedConvoId,
				reply: botReply,
				intent,
				status: convoStatus,
				tokensUsed: Math.floor(message.length / 3) + 25,
				timestamp: now,
			},
			{ headers: CORS_HEADERS },
		);
	} catch (err) {
		return NextResponse.json({ error: err.message }, { status: 500, headers: CORS_HEADERS });
	}
}
