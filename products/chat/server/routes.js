/**
 * Chat's routes (the kit adds its own: connect, notices, tickets, permissions, data rights, widget config, `/sso`,
 * the dashboard API, and for the merchant's server the settings API with Chat's lists, and the activity log). Every browser-token, server-token and ticket route belongs to one feature (ticket routes to their
 * permission's feature unless they name another); `openapi.json` is generated from these definitions
 * (`ss app assets`), so `method`, `path`, `auth`, `feature` and `permission` stay literals. Public entry
 * `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { defineRoute } from '@ss/app-kit';
import { createAdmin } from './admin.js';
import { renderDocs } from './docs.js';
import { createInbox } from './inbox.js';
import { createKnowledge } from './knowledge.js';
import { createReply } from './reply.js';
import { createService } from './service.js';
import { createVisitorApi } from './visitor.js';
import { WIDGET_SCRIPT } from './widget-script.js';

/** @typedef {import('../adapters/product.js').Product} Product */

/** Rate limits of visitor routes (code constants protecting our hosting). */
const CHECK_LIMITS = [
	{ limit: 1200, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 60, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];
const SEND_LIMITS = [
	{ limit: 600, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 20, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];
const MAIL_LIMITS = [
	{ limit: 60, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 3, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];

/**
 * @param {Product} product
 */
export const createRoutes = (product) => {
	const service = createService(product);
	const reply = createReply(product, service);
	const visitor = createVisitorApi(product, service, reply);
	const inbox = createInbox(product, service, reply);
	const knowledge = createKnowledge(product, service);
	const admin = createAdmin(product, service);
	product.attach({ exportUser: admin.exportUser, deleteUser: admin.deleteUser, widgetConfig: admin.widgetConfig });

	return [
		// the widgets' script: public and the same for every website (no token, no Origin needed)
		defineRoute({
			method: 'GET',
			path: '/widget.js',
			auth: 'none',
			handler: () =>
				new Response(WIDGET_SCRIPT, {
					headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),
		// public docs: no sign-in, no tokens
		defineRoute({
			method: 'GET',
			path: '/docs',
			auth: 'none',
			handler: (ctx) =>
				new Response(renderDocs({ base: product.address() ?? new URL(ctx.request.url).origin }), {
					headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/chat',
			auth: 'browser',
			feature: 'visitor_chat',
			rateLimit: CHECK_LIMITS,
			handler: visitor.state,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/chat/unread',
			auth: 'browser',
			feature: 'visitor_chat',
			rateLimit: CHECK_LIMITS,
			handler: visitor.unread,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/messages',
			auth: 'browser',
			feature: 'visitor_chat',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: visitor.send,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/read',
			auth: 'browser',
			feature: 'visitor_chat',
			rateLimit: CHECK_LIMITS,
			handler: visitor.read,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/end',
			auth: 'browser',
			feature: 'visitor_chat',
			rateLimit: SEND_LIMITS,
			handler: visitor.end,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/handoff',
			auth: 'browser',
			feature: 'handoff',
			rateLimit: SEND_LIMITS,
			handler: visitor.handoff,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/contact',
			auth: 'browser',
			feature: 'guest_chat',
			rateLimit: SEND_LIMITS,
			handler: visitor.contact,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/leads',
			auth: 'browser',
			feature: 'leads_flows',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: visitor.lead,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/flows/:flowId/start',
			auth: 'browser',
			feature: 'leads_flows',
			rateLimit: SEND_LIMITS,
			handler: visitor.startFlow,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/flow',
			auth: 'browser',
			feature: 'leads_flows',
			rateLimit: SEND_LIMITS,
			handler: visitor.answerFlow,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/rating',
			auth: 'browser',
			feature: 'ratings',
			rateLimit: SEND_LIMITS,
			handler: visitor.rate,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/transcript',
			auth: 'browser',
			feature: 'transcripts',
			rateLimit: MAIL_LIMITS,
			handler: visitor.transcript,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/chat/uploads',
			auth: 'browser',
			feature: 'attachments',
			rateLimit: SEND_LIMITS,
			handler: visitor.upload,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/conversations',
			auth: 'ticket',
			permission: 'inbox.read',
			handler: inbox.list,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/conversations/count',
			auth: 'ticket',
			permission: 'inbox.read',
			handler: inbox.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/conversations/counts',
			auth: 'ticket',
			permission: 'inbox.read',
			handler: inbox.counts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/conversations/:id',
			auth: 'ticket',
			permission: 'inbox.read',
			handler: inbox.get,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/conversations/:id/read',
			auth: 'ticket',
			permission: 'inbox.read',
			handler: inbox.read,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/conversations/:id/messages',
			auth: 'ticket',
			permission: 'inbox.reply',
			handler: inbox.reply,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/conversations/:id/notes',
			auth: 'ticket',
			feature: 'internal_notes',
			permission: 'inbox.manage',
			handler: inbox.note,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/conversations/:id',
			auth: 'ticket',
			permission: 'inbox.manage',
			handler: inbox.update,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/conversations/:id/summary',
			auth: 'ticket',
			feature: 'ai_summary',
			permission: 'inbox.read',
			handler: inbox.summary,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/conversations/:id/transcript',
			auth: 'ticket',
			feature: 'transcripts',
			permission: 'inbox.reply',
			handler: inbox.transcript,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/conversations/:id/rating-request',
			auth: 'ticket',
			feature: 'ratings',
			permission: 'inbox.reply',
			handler: inbox.askRating,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/uploads',
			auth: 'ticket',
			feature: 'attachments',
			permission: 'inbox.reply',
			handler: inbox.upload,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/inbox/unread',
			auth: 'ticket',
			permission: 'inbox.read',
			handler: inbox.unread,
		}),
		defineRoute({ method: 'GET', path: '/v1/admin/staff', auth: 'ticket', permission: 'inbox.read', handler: inbox.staff }),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/staff/me/presence',
			auth: 'ticket',
			feature: 'presence_queue',
			permission: 'inbox.read',
			handler: inbox.setPresence,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/staff/:id',
			auth: 'ticket',
			feature: 'presence_queue',
			permission: 'inbox.manage',
			handler: inbox.setMaxChats,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/saved-replies',
			auth: 'ticket',
			feature: 'saved_replies',
			permission: 'inbox.read',
			handler: inbox.replies,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/saved-replies',
			auth: 'ticket',
			feature: 'saved_replies',
			permission: 'inbox.manage',
			handler: inbox.createReply,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/saved-replies/:id',
			auth: 'ticket',
			feature: 'saved_replies',
			permission: 'inbox.manage',
			handler: inbox.updateReply,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/saved-replies/:id',
			auth: 'ticket',
			feature: 'saved_replies',
			permission: 'inbox.manage',
			handler: inbox.deleteReply,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/knowledge/entries',
			auth: 'ticket',
			permission: 'knowledge.edit',
			handler: knowledge.entries,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/knowledge/entries',
			auth: 'ticket',
			permission: 'knowledge.edit',
			handler: knowledge.createEntry,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/knowledge/entries/:id',
			auth: 'ticket',
			permission: 'knowledge.edit',
			handler: knowledge.updateEntry,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/knowledge/entries/:id',
			auth: 'ticket',
			permission: 'knowledge.edit',
			handler: knowledge.deleteEntry,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/knowledge/pages',
			auth: 'ticket',
			feature: 'knowledge_pages',
			permission: 'knowledge.edit',
			handler: knowledge.pages,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/knowledge/pages',
			auth: 'ticket',
			feature: 'knowledge_pages',
			permission: 'knowledge.edit',
			handler: knowledge.addPage,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/knowledge/pages/:id/fetch',
			auth: 'ticket',
			feature: 'knowledge_pages',
			permission: 'knowledge.edit',
			handler: knowledge.refetchPage,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/knowledge/pages/:id',
			auth: 'ticket',
			feature: 'knowledge_pages',
			permission: 'knowledge.edit',
			handler: knowledge.deletePage,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/reports',
			auth: 'ticket',
			permission: 'reports.read',
			handler: admin.report,
		}),
		defineRoute({ method: 'GET', path: '/v1/conversations', auth: 'server', feature: 'inbox', handler: inbox.list }),
		defineRoute({
			method: 'GET',
			path: '/v1/conversations/count',
			auth: 'server',
			feature: 'inbox',
			handler: inbox.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/conversations/counts',
			auth: 'server',
			feature: 'inbox',
			handler: inbox.counts,
		}),
		defineRoute({ method: 'GET', path: '/v1/conversations/:id', auth: 'server', feature: 'inbox', handler: inbox.get }),
		defineRoute({
			method: 'POST',
			path: '/v1/conversations/:id/messages',
			auth: 'server',
			feature: 'inbox',
			handler: inbox.reply,
		}),
		defineRoute({ method: 'PATCH', path: '/v1/conversations/:id', auth: 'server', feature: 'inbox', handler: inbox.update }),
		defineRoute({ method: 'DELETE', path: '/v1/conversations/:id', auth: 'server', feature: 'inbox', handler: inbox.remove }),
		defineRoute({ method: 'GET', path: '/v1/inbox/unread', auth: 'server', feature: 'inbox', handler: inbox.unread }),
		defineRoute({ method: 'GET', path: '/v1/leads', auth: 'server', feature: 'leads_flows', handler: inbox.leads }),
		defineRoute({ method: 'GET', path: '/v1/leads/:id', auth: 'server', feature: 'leads_flows', handler: inbox.lead }),
		defineRoute({
			method: 'GET',
			path: '/v1/knowledge/entries',
			auth: 'server',
			feature: 'knowledge_base',
			handler: knowledge.entries,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/knowledge/entries',
			auth: 'server',
			feature: 'knowledge_base',
			handler: knowledge.createEntry,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/knowledge/entries/:id',
			auth: 'server',
			feature: 'knowledge_base',
			handler: knowledge.updateEntry,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/knowledge/entries/:id',
			auth: 'server',
			feature: 'knowledge_base',
			handler: knowledge.deleteEntry,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/knowledge/pages',
			auth: 'server',
			feature: 'knowledge_pages',
			handler: knowledge.pages,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/knowledge/pages',
			auth: 'server',
			feature: 'knowledge_pages',
			handler: knowledge.addPage,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/knowledge/pages/:id/fetch',
			auth: 'server',
			feature: 'knowledge_pages',
			handler: knowledge.refetchPage,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/knowledge/pages/:id',
			auth: 'server',
			feature: 'knowledge_pages',
			handler: knowledge.deletePage,
		}),
		defineRoute({ method: 'GET', path: '/v1/reports', auth: 'server', feature: 'reports', handler: admin.report }),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/websites/:websiteId/lists/:list',
			auth: 'dashboard',
			handler: admin.getList,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/websites/:websiteId/lists/:list',
			auth: 'dashboard',
			handler: admin.putList,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/websites/:websiteId/tool-secret',
			auth: 'dashboard',
			handler: admin.getSecret,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/websites/:websiteId/tool-secret',
			auth: 'dashboard',
			handler: admin.regenerateSecret,
		}),
	];
};
