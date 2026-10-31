'use client';
/**
 * Building blocks shared by console views: the page error (drawn as a Page, layout contract R2) and the two helpers
 * of product dashboards and two-step forms. The list-and-detail layout, its rows and the detail tabs that stood here
 * are gone: lists are rich rows and the parts of a page are sections or `InnerNav` items with their own addresses.
 * @module
 */
import { useEffect, useRef, useState } from 'react';
import { ButtonLink, Page, PasswordConfirmDialog, describeProblem, fieldErrors, problemCode } from '@ss/ui';
import { CONFIRM_CHANGE, CONSOLE, MORE, WEBSITE } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { routes } from '../paths.js';

/** @typedef {import('@ss/ui/problems').Problem} Problem */
/**
 * @template [T=any]
 * @typedef {import('../client.js').ApiResult<T>} ApiResult
 */

/**
 * Page-level error, drawn as a page: the heading in the header (with the `back` page as its parent crumb, a link), the
 * problem in the body and, when the person has to sign in again, the button for it.
 * @param {{ problem: Problem | null | undefined, title?: string, back?: { href: string, label: string }, admin?: boolean }} props
 *   `admin`: an Admin Console page (a refusal says the role does not include the area)
 */
export function PageProblem({ problem, title, back, admin = false }) {
	const code = problemCode(problem);
	const forbidden = code === 'forbidden';
	const heading =
		title ??
		(code === 'not_found'
			? CONSOLE.notFound
			: forbidden
				? admin
					? CONSOLE.notPermitted
					: CONSOLE.noAccess
				: CONSOLE.loadFailed);
	return (
		<Page
			linkAs={Link}
			crumbs={[...(back ? [{ label: back.label, href: back.href }] : []), { label: heading }]}
			error={{
				message: forbidden && admin ? CONSOLE.forbiddenHint(describeProblem(problem)) : describeProblem(problem),
				...(code === 'unauthorized'
					? {
							action: (
								<ButtonLink as={Link} href={routes.login()} variant="primary">
									{CONSOLE.signIn}
								</ButtonLink>
							),
						}
					: {}),
			}}
		/>
	);
}

/**
 * Open a product dashboard: make the single-use launch, then open its URL in a new tab.
 * @param {string} path the launch route
 * @param {unknown} [body]
 * @returns {Promise<ApiResult>}
 */
export const openDashboard = async (path, body) => {
	const result = await apiFetch(path, { method: 'POST', ...(body === undefined ? {} : { body }) });
	if (result.ok && typeof result.data?.url === 'string') window.open(result.data.url, '_blank', 'noopener,noreferrer');
	return result;
};

/**
 * A two-step or recovery code field value → the API members.
 * @param {string} value
 */
export const factorOf = (value) => {
	const v = value.trim();
	if (!v) return {};
	return /^\d{6}$/.test(v) ? { code: v } : { recoveryCode: v };
};

/** Rows per page of the tables fed by the server. */
export const PAGE_SIZE = 50;

/**
 * @param {{ items: any[], cursor: string | null, loading: boolean, problem: unknown, more: () => Promise<unknown> }} list what `usePagedList` returns
 * @param {number} [size] rows per page
 */
export function useListPages(list, size = PAGE_SIZE) {
	const [pageNo, setPageNo] = useState(0);
	const { loading, problem, cursor, more, items } = list;
	const have = items.length;
	const hasMore = cursor !== null;

	// Point 154: When deleting leaves a page empty, go back to the last page that has rows
	const maxPage = Math.max(0, Math.ceil(have / size) - 1);
	const targetPage = !hasMore && pageNo > maxPage ? maxPage : pageNo;

	useEffect(() => {
		if (targetPage !== pageNo) setPageNo(targetPage);
	}, [targetPage, pageNo]);

	const effectivePage = targetPage;
	const start = effectivePage * size;
	const slice = items.slice(start, start + size);

	// Point 155: On Next, keep old rows and the bar until new rows arrive
	const prevRowsRef = useRef(/** @type {any[]} */ ([]));
	if (slice.length > 0) {
		prevRowsRef.current = slice;
	}
	const waiting = slice.length === 0 && effectivePage > 0 && (hasMore || loading);
	const rows = waiting && prevRowsRef.current.length > 0 ? prevRowsRef.current : slice;

	useEffect(() => {
		if (loading || problem || cursor === null || have >= start + size) return;
		void more();
		// `more` is new on every render; the batch to fetch is decided by these values
	}, [loading, problem, cursor, have, start, size]);

	const showPagination = have > 0 || hasMore;

	return {
		rows,
		start,
		waiting,
		/** "37", or "50+" while there is more on the server */
		count: MORE.count(have, hasMore),
		/** back to the first page (after a reload) */
		reset: () => setPageNo(0),
		/** the props of `Pagination`; none while there is nothing to page through */
		pagination:
			!showPagination || (rows.length === 0 && !hasMore)
				? null
				: {
						range: waiting
							? MORE.showing(start + 1, start + size, hasMore)
							: MORE.showing(start + 1, start + slice.length, hasMore),
						hasPrevious: effectivePage > 0,
						hasNext: start + size < have || hasMore,
						onPrevious: () => setPageNo((n) => Math.max(0, n - 1)),
						onNext: () => setPageNo((n) => n + 1),
					},
	};
}

/**
 * The default accents: theme primary (Unite teal) plus earlier Integrity blue stock values a Portal may still have
 * stored; any of these leave the theme's primary (with its dark-mode shade) in place.
 */
const DEFAULT_ACCENTS = new Set(['#0f766e', '#2226f7', '#4f46e5']);

/**
 * Inline style that applies a changed accent to a subtree (the theme reads `--ss-primary`).
 * @param {string | null | undefined} accent
 * @returns {Record<string, string> | undefined}
 */
export const accentStyle = (accent) =>
	accent && /^#[0-9a-f]{6}$/i.test(accent) && !DEFAULT_ACCENTS.has(accent.toLowerCase())
		? { '--ss-primary': accent, '--ss-primary-hover': accent }
		: undefined;

/**
 * @param {{ branding: { name: string, logoUrl: string | null }, tagline?: string }} props
 */
export function BrandMark({ branding, tagline }) {
	const mark =
		String(branding.name ?? 'SS')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? '')
			.join('') || 'SS';
	return (
		<div className="flex items-center gap-3">
			{branding.logoUrl ? (
				<img src={branding.logoUrl} alt="" className="size-9 rounded-control border border-line object-contain" />
			) : (
				<span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-fg font-mono text-micro font-semibold text-canvas">
					{mark}
				</span>
			)}
			<div className="min-w-0">
				<p className="truncate font-display text-title font-semibold tracking-[-0.02em] text-fg">{branding.name}</p>
				{tagline ? <p className="text-xs text-muted">{tagline}</p> : null}
			</div>
		</div>
	);
}

/**
 * What the Portal said to a refused confirmation, as words for the field it belongs to: a wrong password under the
 * password, a missing or wrong code under the code; anything else (too many tries, a server problem) under the fields.
 * @param {Problem | null} problem
 * @returns {{ password?: string, code?: string, form?: string }}
 */
export const confirmationErrors = (problem) => {
	if (!problem) return {};
	const fields = fieldErrors(problem);
	if (fields.code || fields.recoveryCode) return { code: WEBSITE.needsCode };
	if (problemCode(problem) === 'invalid_credentials')
		return /code/i.test(String(problem.detail ?? '')) ? { code: WEBSITE.wrongCode } : { password: WEBSITE.wrongPassword };
	if (fields.password) return { password: WEBSITE.wrongPassword };
	return { form: describeProblem(problem) };
};

/**
 * The password dialog of a change: the person's password (and a code when the Portal asks for one), the request, and the
 * reason under its field when refused.
 * @param {{ open: boolean, title: string, help: string, confirmLabel: string, danger?: boolean, expected?: string,
 *   twoStepOn?: boolean, otpOnly?: boolean,
 *   send: (confirmation: any) => Promise<{ ok: true } | { ok: false, problem: Problem } | any>,
 *   onClose: () => void, onDone: () => void }} props
 */
export function ConfirmChange({
	open,
	title,
	help,
	confirmLabel,
	danger = false,
	expected,
	send,
	twoStepOn = false,
	otpOnly = false,
	onClose,
	onDone,
}) {
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState(/** @type {{ password?: string, code?: string, form?: string }} */ ({}));
	const [wantsCode, setWantsCode] = useState(otpOnly || twoStepOn);
	useEffect(() => {
		if (open) {
			setWantsCode(otpOnly || twoStepOn);
			setErrors({});
		}
	}, [open, twoStepOn, otpOnly]);
	/** @param {{ password?: string, code: string }} input */
	const confirm = async ({ password, code }) => {
		setBusy(true);
		setErrors({});
		try {
			const payload = otpOnly ? factorOf(code) : { ...(password !== undefined ? { password } : {}), ...factorOf(code) };
			const result = await send(payload);
			setBusy(false);
			if (result.ok) {
				onDone();
				return;
			}
			const found = confirmationErrors(result.problem);
			if (found.code) setWantsCode(true);
			if (!found.password && !found.code && result.problem.status === 422) {
				onClose();
				return;
			}
			setErrors(found);
		} catch (error) {
			setBusy(false);
			setErrors({ form: error instanceof Error ? error.message : 'The confirmation failed.' });
		}
	};
	return (
		<PasswordConfirmDialog
			open={open}
			onClose={onClose}
			onConfirm={(input) => void confirm(input)}
			busy={busy}
			danger={danger}
			showCode={otpOnly || wantsCode}
			otpOnly={otpOnly}
			{...(expected === undefined ? {} : { expected })}
			confirmLabel={confirmLabel}
			title={title}
			errors={errors}
			texts={CONFIRM_CHANGE}>
			<p className="text-sm text-muted">{help}</p>
		</PasswordConfirmDialog>
	);
}

/**
 * Step-up confirmation dialog using OTP only (no password field).
 * @param {Omit<Parameters<typeof ConfirmChange>[0], 'otpOnly'>} props
 */
export function ConfirmOtp(props) {
	return <ConfirmChange {...props} otpOnly />;
}

