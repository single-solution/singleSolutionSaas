'use client';
/**
 * Impersonation banner of the **Merchant Console**: shown on every page while the merchant session carries `via`
 * (a staff member acting as this user, time-boxed). It names the staff member and the end of the session, and ends
 * the impersonation on request: signing the impersonation session out revokes it (audited on both chains). The data comes from `loadImpersonation`
 * (`GET /v1/system/whoami`: `actor.via`, `session.expiresAt`).
 * @module
 */
import { useState } from 'react';
import { Button, Callout, formatDateTime } from '@ss/ui';
import { apiFetch } from '../../client.js';
import { adminRoutes } from '../paths.js';

/**
 * @param {{ impersonation: { staffId: string, staffName?: string | null, expiresAt: string | null } | null,
 *   userEmail?: string | null }} props
 */
export function ImpersonationBanner({ impersonation, userEmail = null }) {
	const [busy, setBusy] = useState(false);
	if (!impersonation) return null;
	const end = async () => {
		setBusy(true);
		await apiFetch('/v1/auth/merchant/logout', { method: 'POST', redirectOn401: false });
		window.location.assign(adminRoutes.merchants());
	};
	return (
		<section aria-label="Impersonation" data-impersonation="true">
			<Callout
				tone="warning"
				live={false}
				title={`Staff impersonation${userEmail ? ` of ${userEmail}` : ''}`}
				actions={
					<Button size="sm" variant="secondary" onClick={() => void end()} loading={busy}>
						End impersonation
					</Button>
				}>
				Staff member {impersonation.staffName ? <strong>{impersonation.staffName}</strong> : null}{' '}
				<span className="font-mono">({impersonation.staffId})</span> is acting as this user
				{impersonation.expiresAt ? ` until ${formatDateTime(impersonation.expiresAt)}` : ''}. Every action is recorded in the
				audit log under their name.
			</Callout>
		</section>
	);
}
