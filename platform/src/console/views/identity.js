'use client';
/**
 * Website settings → Identity (bring-your-own customer identity, PLAN §5.3): the issuer of the website's own login,
 * its public keys (a JWKS URL the Portal fetches, or up to five keys pasted inline), the expected audience and the
 * claims that hold the customer id, e-mail and phone. Products then accept the site's login tokens in `SS-Identity`.
 * @module
 */
import { useState } from 'react';
import {
	Badge,
	Button,
	Callout,
	Card,
	ConfirmDialog,
	FormError,
	Input,
	KeyValueList,
	RadioGroup,
	TextArea,
	describeProblem,
	fieldErrors,
	formatDateTime,
	useToast,
} from '@ss/ui';
import { apiFetch } from '../client.js';
import { api } from '../paths.js';
import { PageProblem, WebsiteHeader } from './common.js';

/** @typedef {import('@ss/ui').Problem} Problem */

/**
 * @typedef {object} IssuerForm
 * @property {string} issuer
 * @property {'jwks_url' | 'inline'} source
 * @property {string} jwksUrl
 * @property {string} keys JSON: a JWKS (`{ keys: [...] }`), an array of JWKs or one JWK
 * @property {string} audience
 * @property {string} subject
 * @property {string} email
 * @property {string} phone
 */

/**
 * The form state for a stored issuer (or an empty form).
 * @param {Record<string, any> | null | undefined} issuer
 * @returns {IssuerForm}
 */
export const formOf = (issuer) => ({
	issuer: issuer?.issuer ?? '',
	source: issuer?.source === 'inline' ? 'inline' : 'jwks_url',
	jwksUrl: issuer?.jwksUrl ?? '',
	keys: '',
	audience: issuer?.audience ?? '',
	subject: issuer?.claimMap?.subject ?? 'sub',
	email: issuer?.claimMap?.email ?? '',
	phone: issuer?.claimMap?.phone ?? '',
});

/**
 * The request body of a form, or field errors found before sending.
 * @param {IssuerForm} form
 * @returns {{ ok: true, body: Record<string, unknown> } | { ok: false, errors: Record<string, string> }}
 */
export const issuerBody = (form) => {
	/** @type {Record<string, string>} */
	const errors = {};
	if (!form.issuer.trim()) errors.issuer = 'Enter the issuer (the `iss` of your login tokens).';
	/** @type {unknown[] | null} */
	let keys = null;
	if (form.source === 'jwks_url') {
		if (!/^https?:\/\/\S+$/.test(form.jwksUrl.trim())) errors.jwksUrl = 'Enter the https URL of your JWKS.';
	} else {
		try {
			const parsed = JSON.parse(form.keys);
			const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.keys) ? parsed.keys : [parsed];
			if (list.length === 0 || list.length > 5) errors.publicJwks = 'Paste between one and five public keys.';
			keys = list;
		} catch {
			errors.publicJwks = 'Paste a JWKS or public JWKs as JSON.';
		}
	}
	if (!form.subject.trim()) errors['claimMap.subject'] = 'Name the claim that holds the customer id.';
	if (Object.keys(errors).length > 0) return { ok: false, errors };
	/** @type {Record<string, string>} */
	const claimMap = { subject: form.subject.trim() };
	if (form.email.trim()) claimMap.email = form.email.trim();
	if (form.phone.trim()) claimMap.phone = form.phone.trim();
	return {
		ok: true,
		body: {
			issuer: form.issuer.trim(),
			...(form.source === 'jwks_url' ? { jwksUrl: form.jwksUrl.trim() } : { publicJwks: keys }),
			...(form.audience.trim() ? { audience: form.audience.trim() } : {}),
			claimMap,
		},
	};
};

/**
 * The error of the pasted keys (the whole list or one key, `publicJwks.<i>`).
 * @param {Record<string, string>} errors
 * @returns {string | undefined}
 */
export const keysError = (errors) =>
	errors.publicJwks ?? Object.entries(errors).find(([key]) => key.startsWith('publicJwks.'))?.[1];

/**
 * @param {any} props loader result of `loadIdentity`
 */
export function IdentityView(props) {
	const toast = useToast();
	const ok = props.ok === true;
	const [issuer, setIssuer] = useState(/** @type {Record<string, any> | null} */ (ok ? props.issuer : null));
	const [form, setForm] = useState(() => formOf(ok ? props.issuer : null));
	const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
	const [problem, setProblem] = useState(/** @type {Problem | null} */ (null));
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	if (!ok) return <PageProblem problem={props.problem} />;
	const { merchantId, website } = props;
	const path = api.identity(merchantId, website.websiteId);
	/** @param {keyof IssuerForm} key @returns {(e: { currentTarget: { value: string } }) => void} */
	const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });

	const save = async () => {
		const built = issuerBody(form);
		if (!built.ok) {
			setErrors(built.errors);
			return;
		}
		setErrors({});
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(path, { method: 'PUT', body: built.body });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			setErrors(fieldErrors(result.problem));
			return;
		}
		setIssuer(result.data.issuer);
		setForm(formOf(result.data.issuer));
		toast.show({ title: 'Identity issuer saved', description: 'Products accept your login tokens within minutes.' });
	};
	const refresh = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(`${path}/refresh`, { method: 'POST' });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setIssuer(result.data.issuer);
		toast.show({ title: result.data.issuer.lastError ? 'Keys could not be fetched' : 'Keys refreshed' });
	};
	const remove = async () => {
		setBusy(true);
		setProblem(null);
		const result = await apiFetch(path, { method: 'DELETE' });
		setBusy(false);
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		setRemoving(false);
		setIssuer(null);
		setForm(formOf(null));
		toast.show({ title: 'Identity issuer removed' });
	};

	return (
		<div className="space-y-6">
			<WebsiteHeader website={website} active="identity" title="Customer identity" />
			<Callout tone="info" live={false}>
				Let products recognise your signed-in customers with your own login: register the issuer of your login tokens (JWTs
				signed with EdDSA, ES256 or RS256). Your site sends the token in the <span className="font-mono">SS-Identity</span>{' '}
				header; products verify it offline with the public keys below. Tokens must expire and be at most 24 hours old.
			</Callout>
			{issuer ? (
				<Card
					title="Current issuer"
					actions={
						<span className="inline-flex gap-2">
							{issuer.source === 'jwks_url' ? (
								<Button size="sm" variant="secondary" onClick={() => void refresh()} loading={busy}>
									Refresh keys
								</Button>
							) : null}
							<Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
								Remove
							</Button>
						</span>
					}>
					<KeyValueList
						items={[
							{ label: 'Issuer', value: <span className="font-mono text-xs">{issuer.issuer}</span> },
							{ label: 'Audience', value: issuer.audience ?? 'Any' },
							{
								label: 'Keys',
								value: (
									<span className="flex flex-wrap gap-1">
										{(issuer.keys ?? []).map((/** @type {any} */ k) => (
											<Badge key={k.kid}>
												{k.kid} · {k.alg}
											</Badge>
										))}
									</span>
								),
							},
							{
								label: 'Source',
								value:
									issuer.source === 'jwks_url'
										? `JWKS URL${issuer.keysFetchedAt ? ` (fetched ${formatDateTime(issuer.keysFetchedAt)})` : ''}`
										: 'Pasted keys',
							},
							{
								label: 'Claims',
								value: Object.entries(issuer.claimMap ?? {})
									.map(([field, claim]) => `${field} ← ${claim}`)
									.join(', '),
							},
						]}
					/>
					{issuer.lastError ? (
						<Callout tone="warning" live={false}>
							The last key refresh failed: {issuer.lastError}. The previous keys stay in use.
						</Callout>
					) : null}
				</Card>
			) : null}
			<Card title={issuer ? 'Change the issuer' : 'Register your identity issuer'}>
				<div className="space-y-4">
					<Input
						label="Issuer"
						value={form.issuer}
						onChange={set('issuer')}
						error={errors.issuer}
						help="Exactly the `iss` claim of your tokens, e.g. https://login.example.com/"
						className="font-mono"
					/>
					<RadioGroup
						legend="Public keys"
						value={form.source}
						onChange={(v) => setForm({ ...form, source: v === 'inline' ? 'inline' : 'jwks_url' })}
						options={[
							{ value: 'jwks_url', label: 'Fetch them from a JWKS URL (rotations are picked up hourly)' },
							{ value: 'inline', label: 'Paste up to five public keys' },
						]}
					/>
					{form.source === 'jwks_url' ? (
						<Input
							label="JWKS URL"
							value={form.jwksUrl}
							onChange={set('jwksUrl')}
							error={errors.jwksUrl}
							className="font-mono"
						/>
					) : (
						<TextArea
							label="Public keys (JSON)"
							value={form.keys}
							onChange={set('keys')}
							error={keysError(errors)}
							rows={6}
							help="A JWKS or public JWKs. Never paste a private key."
							className="font-mono text-xs"
						/>
					)}
					<Input label="Audience (optional)" value={form.audience} onChange={set('audience')} error={errors.audience} />
					<div className="grid gap-4 sm:grid-cols-3">
						<Input
							label="Customer id claim"
							value={form.subject}
							onChange={set('subject')}
							error={errors['claimMap.subject']}
						/>
						<Input
							label="E-mail claim (optional)"
							value={form.email}
							onChange={set('email')}
							error={errors['claimMap.email']}
						/>
						<Input
							label="Phone claim (optional)"
							value={form.phone}
							onChange={set('phone')}
							error={errors['claimMap.phone']}
						/>
					</div>
					<FormError problem={problem} fields={['issuer', 'jwksUrl', 'publicJwks', 'audience', 'claimMap']} />
					<Button onClick={() => void save()} loading={busy}>
						{issuer ? 'Save changes' : 'Register issuer'}
					</Button>
				</div>
			</Card>
			<ConfirmDialog
				open={removing}
				onClose={() => setRemoving(false)}
				onConfirm={() => void remove()}
				busy={busy}
				danger
				title="Remove the identity issuer?"
				confirmLabel="Remove issuer"
				error={problem ? describeProblem(problem) : null}>
				<p className="text-sm text-muted">
					Products stop recognising your login tokens; customers fall back to each product's own sign-in.
				</p>
			</ConfirmDialog>
		</div>
	);
}
