/**
 * Reports (widget and server API), the dashboard's own routes (list settings and the tool signing secret), the
 * data-rights hooks (export and delete one person's conversations, messages, attachments and leads) and the widget
 * settings the kit's widget config routes answer. Our admins see setup only: nothing here returns business data to a
 * dashboard session.
 * @module
 */
import { problem } from '@ss/app-kit';
import { reportRange, summarise } from '../core/reports.js';
import { dayStart } from '../core/time.js';
import { MAX_ATTACHMENT_BYTES } from '../core/widgets.js';
import { LISTS } from '../adapters/lists.js';
import { createStore } from '../adapters/store.js';
import { deleteConversations } from './inbox.js';
import { bodyOf, invalid } from './service.js';

/** @typedef {import('./service.js').Site} Site */

/**
 * @param {import('../adapters/product.js').Product} product
 * @param {import('./service.js').Service} service
 */
export const createAdmin = (product, service) => {
	const { now } = product;

	/** @param {any} ctx */
	const report = async (ctx) => {
		const s = await service.site(ctx);
		const { timeZone } = await s.business();
		const range = reportRange(ctx.query, now(), timeZone);
		if (!range) throw invalid(['Use from and to as YYYY-MM-DD, from not after to, at most 366 days.']);
		const from = new Date(dayStart(range.from, timeZone));
		const to = new Date(
			dayStart(new Date(Date.parse(`${range.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), timeZone),
		);
		const rows = await s.store.conversations.startedBetween(from, to);
		const dayKeys = range.dates.map((date) => `day:${date}`);
		const numbers = summarise({
			rows: rows.map((row) => ({ ...row, aiReplies: Number(row.aiReplies ?? 0), firstVisitorAt: row.firstVisitorAt ?? null })),
			dates: range.dates,
			timeZone,
			leads: await s.store.leads.countBetween(from, to),
			aiTokens: await s.store.usage.total(dayKeys),
		});
		return {
			from: range.from,
			to: range.to,
			timeZone,
			...numbers,
			visitorMessages: await s.store.messages.visitorCountBetween(from, to),
		};
	};

	// ------------------------------------------------------------------------------------------------ dashboard

	/** @param {any} ctx */
	const listName = (ctx) => {
		const name = String(ctx.params.list);
		if (!Object.hasOwn(LISTS, name)) throw problem('not_found', 'No such list.');
		return /** @type {import('../adapters/lists.js').ListName} */ (name);
	};

	/** @param {any} ctx */
	const getList = async (ctx) => ({ items: await product.lists.get(String(ctx.params.websiteId), listName(ctx)) });

	/** @param {any} ctx */
	const who = (ctx) => ({
		kind: ctx.session.kind,
		id: ctx.session.subject,
		name: ctx.session.name,
		...(ctx.session.role ? { role: ctx.session.role } : {}),
	});

	/**
	 * Merchants edit the settings of switched-on features only (admins may prepare them).
	 * @param {any} ctx
	 * @param {string[]} features
	 */
	const editable = async (ctx, features) => {
		const on = await product.featuresOn(String(ctx.params.websiteId));
		if (ctx.session.kind === 'merchant' && !features.some((f) => on.includes(f)))
			throw problem('feature_off', 'This feature is off.');
	};

	/** @param {any} ctx */
	const putList = async (ctx) => {
		const name = listName(ctx);
		const websiteId = String(ctx.params.websiteId);
		await editable(ctx, [LISTS[name].feature]);
		const saved = await product.lists.save(websiteId, name, bodyOf(ctx.body).items);
		if (!saved.ok) throw invalid(saved.errors);
		await product.recentChanges.record({ websiteId, who: who(ctx), what: 'settings', detail: `${LISTS[name].title}: changed` });
		return { items: saved.value };
	};

	/** @param {any} ctx */
	const getSecret = async (ctx) => {
		await editable(ctx, ['webhook_tools', 'book_slot']);
		return { secret: await product.lists.toolSecret(String(ctx.params.websiteId)) };
	};

	/** @param {any} ctx */
	const regenerateSecret = async (ctx) => {
		const websiteId = String(ctx.params.websiteId);
		await editable(ctx, ['webhook_tools', 'book_slot']);
		const secret = await product.lists.toolSecret(websiteId, { regenerate: true });
		await product.recentChanges.record({
			websiteId,
			who: who(ctx),
			what: 'settings',
			detail: 'Tool signing secret: regenerated',
		});
		return { secret };
	};

	// ---------------------------------------------------------------------------------------------- data rights

	/**
	 * One person's conversations: by Accounts user id (guest chats merged into the account included) and by the e-mail
	 * or phone a guest left.
	 * @param {any} ctx
	 * @param {{ id?: string, email?: string, phone?: string }} user
	 */
	const personOf = async (ctx, user) => {
		const store = createStore(await ctx.data(), { now });
		const conversations = await store.conversations.ofPerson(user);
		const leads = await store.leads.ofPerson(
			user,
			conversations.map((c) => c.id),
		);
		return { store, conversations, leads };
	};

	/** @type {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>['exportUser']} */
	const exportUser = async (ctx, user) => {
		const { store, conversations, leads } = await personOf(ctx, user);
		const messages = (await store.messages.ofConversations(conversations.map((c) => c.id))).filter((m) => !m.internal);
		return {
			conversations: conversations.map((c) => ({
				id: c.id,
				name: c.name,
				email: c.email,
				phone: c.phone,
				status: c.status,
				page: c.page,
				fields: c.fields,
				rating: c.rating,
				createdAt: new Date(c.createdAt).toISOString(),
				messages: messages
					.filter((m) => m.conversationId === c.id)
					.map((m) => ({
						author: m.author,
						text: m.text,
						...(m.attachment
							? { attachment: { name: m.attachment.name, type: m.attachment.type, size: m.attachment.size } }
							: {}),
						at: new Date(m.createdAt).toISOString(),
					})),
			})),
			leads: leads.map((lead) => ({ ...lead, createdAt: new Date(lead.createdAt).toISOString() })),
		};
	};

	/** @type {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>['deleteUser']} */
	const deleteUser = async (ctx, user) => {
		const { store, conversations, leads } = await personOf(ctx, user);
		const s = /** @type {Site} */ ({ websiteId: String(ctx.websiteId), store });
		const deleted = (await deleteConversations(product, s, conversations)) + (await store.leads.remove(leads.map((l) => l.id)));
		return { deleted, anonymised: 0 };
	};

	// --------------------------------------------------------------------------------------------- widget config

	/** @type {NonNullable<import('@ss/app-kit').ProductOptions['hooks']>['widgetConfig']} */
	const widgetConfig = async (ctx) => {
		const websiteId = String(ctx.websiteId);
		const on = await product.featuresOn(websiteId);
		/** @param {string} feature */
		const values = (feature) => product.settings.values(websiteId, feature);
		const look = await values('visitor_chat');
		const guests = await values('guest_chat');
		const leads = await values('leads_flows');
		const attachments = await values('attachments');
		const ratings = await values('ratings');
		const flows = on.includes('leads_flows') ? await product.lists.get(websiteId, 'flows') : [];
		return {
			look: {
				botName: look.botName,
				avatarUrl: /^https:\/\//.test(String(look.avatarUrl)) ? look.avatarUrl : '',
				launcherPosition: look.launcherPosition,
				launcherStyle: look.launcherStyle,
				windowStyle: look.windowStyle,
				fullScreenOnMobile: look.fullScreenOnMobile,
				hideOnPages: look.hideOnPages,
			},
			guests: { messageLimit: guests.messageLimit, rememberDays: guests.rememberDays, contactCapture: guests.contactCapture },
			signInUrl: on.includes('signed_in_chat') ? (await values('signed_in_chat')).signInUrl : '',
			ai: { showLabel: (await values('ai_replies')).showAiLabel },
			proactive: {
				idleMinutes: (await values('proactive_idle')).idleMinutes,
				dismissDays: look.proactiveDismissDays,
				pageRules: on.includes('proactive_pages') ? await product.lists.get(websiteId, 'page_rules') : [],
			},
			flows: flows.filter((f) => f.start.kind === 'page').map((f) => ({ id: f.id, name: f.name, start: f.start })),
			leads: { fields: leads.leadFields, customFields: leads.customLeadFields, consentText: leads.consentText },
			customFields: on.includes('custom_fields') ? await product.lists.get(websiteId, 'custom_fields') : [],
			attachments: {
				visitors: attachments.visitorUploads,
				types: attachments.allowedTypes,
				maxBytes: Math.min(Number(attachments.maxSizeMb) * 1024 * 1024, MAX_ATTACHMENT_BYTES),
				storage: on.includes('attachments') && (await product.connections.storage(websiteId)) !== null,
			},
			ratings: { scale: Number(ratings.scale), askWhen: ratings.askWhen, comment: ratings.askComment },
			queuePosition: (await values('presence_queue')).queuePosition,
		};
	};

	return Object.freeze({ report, getList, putList, getSecret, regenerateSecret, exportUser, deleteUser, widgetConfig });
};
