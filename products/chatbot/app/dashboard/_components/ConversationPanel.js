'use client';
/**
 * Live conversation for agents: messages refreshed with the product's polling transport (visible tab only, idle
 * back-off and stop, ETag 304s), a reply box with canned replies, internal notes and the status selector. Every action
 * is a dashboard API call with the session cookie (`/v1/dashboard/conversations/...`), audited by the product.
 */
import { createElement as h, useEffect, useRef, useState } from 'react';
import { Button, Callout, Select, TextArea } from '@ss/ui';
import { mergeMessages } from '../../../core/conversation.js';
import { createTransport } from '../../../headless/transport.js';
import { createTranslator } from '../../../headless/strings.js';
import en from '../../../strings/en.json' with { type: 'json' };

const t = createTranslator(en);
const STATUSES = ['open', 'pending', 'resolved', 'closed'];

/**
 * @param {{ initial: { conversation: Record<string, any>, messages: any[], notes: any[] }, websiteId: string | null, canWrite: boolean,
 *   inbox: boolean, canned: Array<{ key: string, title: string, body: string }>, pollMs: number }} props
 */
export function ConversationPanel({ initial, websiteId, canWrite, inbox, canned, pollMs }) {
	const [conversation, setConversation] = useState(initial.conversation);
	const [messages, setMessages] = useState(initial.messages);
	const [notes, setNotes] = useState(initial.notes);
	const [reply, setReply] = useState('');
	const [note, setNote] = useState('');
	const [status, setStatus] = useState(String(initial.conversation.status));
	const [error, setError] = useState(/** @type {string | null} */ (null));
	const etag = useRef(/** @type {string | null} */ (null));
	const last = useRef(initial.messages.at(-1)?.at ?? null);
	const base = `/v1/dashboard/conversations/${encodeURIComponent(initial.conversation.id)}`;
	const headers = (/** @type {Record<string, string>} */ extra = {}) => ({
		...(websiteId ? { 'x-ss-website': websiteId } : {}),
		...extra,
	});

	useEffect(() => {
		if (!websiteId) return undefined;
		const doc = globalThis.document;
		const transport = createTransport({
			intervalMs: pollMs,
			idleAfterMs: 300_000,
			idleIntervalMs: 30_000,
			stopAfterMs: 1_800_000,
			burstIntervalMs: 3_000,
			burstWindowMs: 30_000,
			scheduler: {
				setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
				clearTimeout: (handle) => globalThis.clearTimeout(/** @type {any} */ (handle)),
				now: Date.now,
			},
			visibility: doc
				? {
						hidden: () => doc.hidden,
						subscribe: (listener) => {
							doc.addEventListener('visibilitychange', listener);
							globalThis.addEventListener('pointerdown', listener);
							return () => {
								doc.removeEventListener('visibilitychange', listener);
								globalThis.removeEventListener('pointerdown', listener);
							};
						},
					}
				: null,
			onTick: async () => {
				const response = await fetch(`${base}${last.current ? `?since=${encodeURIComponent(last.current)}` : ''}`, {
					headers: headers(etag.current ? { 'if-none-match': etag.current } : {}),
				});
				if (response.status === 304 || !response.ok) return;
				const body = await response.json();
				etag.current = body.etag ?? null;
				setConversation(body.conversation);
				setMessages((current) => {
					const merged = mergeMessages(current, body.items ?? []);
					last.current = merged.at(-1)?.at ?? last.current;
					return merged;
				});
			},
		});
		transport.start();
		return () => transport.stop();
	}, [base, pollMs, websiteId]);

	/** @param {string} path @param {string} method @param {Record<string, unknown>} body */
	const send = async (path, method, body) => {
		setError(null);
		const response = await fetch(path, {
			method,
			headers: headers({
				'content-type': 'application/json',
				...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
			}),
			body: JSON.stringify(body),
		});
		const json = await response.json().catch(() => ({}));
		if (!response.ok) setError(json.detail ?? json.title ?? String(response.status));
		return response.ok ? json : null;
	};

	const list = messages.map((m) =>
		h(
			'li',
			{
				key: m.id,
				className: `rounded-md px-3 py-2 ${m.author === 'customer' ? 'bg-surface-2' : m.author === 'system' ? 'text-center text-sm text-muted' : 'bg-surface'}`,
			},
			h(
				'span',
				{ className: 'block text-xs text-muted' },
				`${m.authorName ?? t(`window.author.${m.author}`)} · ${m.at.slice(0, 16).replace('T', ' ')}`,
			),
			h('span', { className: 'whitespace-pre-wrap' }, m.text),
		),
	);
	return h(
		'div',
		{ className: 'space-y-4' },
		h(
			'ol',
			{
				className: 'max-h-[28rem] space-y-2 overflow-y-auto',
				'aria-live': 'polite',
				'aria-label': t('window.messages.label'),
			},
			list,
		),
		error ? h(Callout, { tone: 'danger' }, error) : null,
		canWrite && inbox
			? h(
					'form',
					{
						className: 'space-y-2',
						onSubmit: async (/** @type {any} */ event) => {
							event.preventDefault();
							const result = await send(`${base}/messages`, 'POST', { text: reply });
							if (result) {
								setReply('');
								setMessages((current) => mergeMessages(current, [result.message]));
								setConversation(result.conversation);
							}
						},
					},
					canned.length > 0
						? h(Select, {
								label: t('dashboard.conversation.canned'),
								value: '',
								options: [{ value: '', label: '—' }, ...canned.map((c) => ({ value: c.key, label: c.title }))],
								onChange: (/** @type {any} */ e) => setReply(canned.find((c) => c.key === e.target.value)?.body ?? reply),
							})
						: null,
					h(TextArea, {
						label: t('dashboard.conversation.reply'),
						value: reply,
						rows: 3,
						onChange: (/** @type {any} */ e) => setReply(e.target.value),
					}),
					h(Button, { type: 'submit', disabled: !reply.trim() }, t('dashboard.conversation.send')),
				)
			: null,
		canWrite && inbox
			? h(
					'form',
					{
						className: 'space-y-2',
						onSubmit: async (/** @type {any} */ event) => {
							event.preventDefault();
							const result = await send(`${base}/notes`, 'POST', { text: note });
							if (result) {
								setNote('');
								setNotes((current) => [...current, result]);
							}
						},
					},
					h(TextArea, {
						label: t('dashboard.conversation.note'),
						value: note,
						rows: 2,
						onChange: (/** @type {any} */ e) => setNote(e.target.value),
					}),
					h(Button, { type: 'submit', variant: 'secondary', disabled: !note.trim() }, t('dashboard.conversation.add_note')),
					h(
						'ul',
						{ className: 'space-y-1 text-sm text-muted' },
						notes.map((n) => h('li', { key: n.id }, `${n.authorName ?? '—'}: ${n.text}`)),
					),
				)
			: null,
		canWrite
			? h(
					'form',
					{
						className: 'flex items-end gap-2',
						onSubmit: async (/** @type {any} */ event) => {
							event.preventDefault();
							const result = await send(base, 'PATCH', { status });
							if (result) setConversation(result);
						},
					},
					h(Select, {
						label: t('dashboard.conversation.status'),
						value: status,
						options: STATUSES.map((value) => ({ value, label: t(`dashboard.status.${value}`) })),
						onChange: (/** @type {any} */ e) => setStatus(e.target.value),
					}),
					h(
						Button,
						{ type: 'submit', variant: 'secondary', disabled: status === conversation.status },
						t('dashboard.conversation.save'),
					),
				)
			: null,
	);
}
