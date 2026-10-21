'use client';
/**
 * The features inside Settings (owner 2026-10-21: the Features tab is folded into Settings). Every feature is a row of
 * Settings with its switch for those who may switch (Owner and Support; a merchant sees it locked), a status dot for
 * a merchant, the price and how many settings the website changed, and a warning in place of those when something
 * blocks it. A switch asks first: the confirmation says the new hourly cost, what goes off with it (the features that
 * need it) and the product's own warnings. The page of a feature that is off says what it is and how to switch it on.
 * @module
 */
import { useState } from 'react';
import { TextLink } from './display.js';
import { Switch } from './fields.js';
import { NextStep } from './NextStep.js';
import { ConfirmDialog } from './overlay.js';
import { call, fill } from './dashboard-api.js';
import { formatCreditsPerHour, supportContact } from './format.js';
import { useDashboard, withDependents } from './dashboard-parts.js';
import { websiteSettingsUrl } from './portal-links.js';
import { useDisplayLocale } from './time.js';

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./dashboard-tabs.js').Feature} Feature */
/** @typedef {import('./dashboard-tabs.js').Connection} Connection */
/** @typedef {import('./dashboard-tabs.js').Who} Who */
/** @typedef {import('./dashboard-parts.js').Dashboard} Dashboard */
/** @typedef {import('./dashboard-parts.js').FeatureSettings} FeatureSettings */
/** @typedef {import('./dashboard-settings.js').FeatureLook} FeatureLook */

/**
 * The switches of a website's features: `ask(feature, checked)` opens the confirmation of switching one on or off, and
 * saving it writes the new list of features that are on. Draw `dialog` once in the page; `result` is the last save's
 * outcome and `warned` the product's warnings for the features that are on now.
 * @param {{ base: string, catalog: Feature[], warnings?: (on: string[]) => string[], reload: () => void }} options
 *   `base`: the website's dashboard address; `warnings`: the product's rules between features, from the ones on;
 *   `reload`: reads the features and their settings again after a save
 */
export function useFeatureSwitches({ base, catalog, warnings, reload }) {
	const { texts, namesOf } = useDashboard();
	const locale = useDisplayLocale();
	const F = texts.features;
	const [asked, setAsked] = useState(
		/** @type {{ feature: Feature, checked: boolean, on: string[], alsoOff: string[] } | null} */ (null),
	);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(/** @type {Answer | null} */ (null));
	const saved = catalog.filter((feature) => feature.on).map((feature) => feature.key);
	/** @param {string[]} on */
	const costOf = (on) => catalog.reduce((sum, feature) => sum + (on.includes(feature.key) ? feature.millicreditsPerHour : 0), 0);
	/** @param {Feature} feature @param {boolean} checked */
	const ask = (feature, checked) => {
		const off = withDependents(catalog, saved, feature.key);
		const on = checked ? [...saved, feature.key] : saved.filter((key) => !off.has(key));
		setAsked({
			feature,
			checked,
			on,
			alsoOff: saved.filter((key) => key !== feature.key && !on.includes(key)),
		});
		setOpen(true);
	};
	const picked = asked ? (warnings ? warnings(asked.on) : []) : [];
	const dialog = asked ? (
		<ConfirmDialog
			open={open}
			busy={busy}
			title={fill(asked.checked ? F.switchOnTitle : F.switchOffTitle, { name: asked.feature.name })}
			confirmLabel={asked.checked ? F.switchOn : F.switchOff}
			cancelLabel={texts.cancel}
			onClose={() => setOpen(false)}
			onConfirm={async () => {
				setBusy(true);
				const next = await call('PUT', `${base}/features`, { on: asked.on });
				setBusy(false);
				setOpen(false);
				setResult(next);
				if (next.ok) reload();
			}}>
			<p>{fill(F.confirmCost, { cost: formatCreditsPerHour(costOf(asked.on), { locale }) })}</p>
			{asked.alsoOff.length > 0 ? <p>{fill(F.alsoOff, { features: namesOf(asked.alsoOff) })}</p> : null}
			{picked.map((warning) => (
				<p key={warning}>{warning}</p>
			))}
		</ConfirmDialog>
	) : null;
	return { ask, dialog, result, warned: warnings ? warnings(saved) : [], cost: costOf(saved) };
}

/**
 * How Settings draws each feature of a website: its row (icon, switch, status, price and changes, or the warning) and
 * its page (what a feature that is off is, and how to switch it on; a notice per connection that does not work).
 * @param {{ catalog: Feature[], links: Connection[], who: Who, dash: Dashboard, locale: string,
 *   ask: (feature: Feature, checked: boolean) => void, support: { channels: import('./format.js').SupportChannel[] },
 *   portal: string, merchantId?: string | null, websiteId: string | null,
 *   open?: (tab: string, section?: string) => void }} options
 * @returns {(settings: FeatureSettings) => FeatureLook}
 */
export function featureLooks({ catalog, links, who, dash, locale, ask, support, portal, merchantId, websiteId, open }) {
	const { texts, namesOf } = dash;
	const F = texts.features;
	const admin = who.kind === 'admin';
	const byKey = new Map(catalog.map((feature) => [feature.key, feature]));
	const onNow = catalog.filter((feature) => feature.on).map((feature) => feature.key);
	return (settings) => {
		const feature = byKey.get(settings.key);
		if (!feature) return {};
		const on = Boolean(feature.on);
		const missing = feature.dependsOn.filter((key) => !onNow.includes(key));
		const blocked = !on && missing.length > 0;
		const broken = on ? links.filter((link) => link.neededBy.includes(feature.key) && link.status !== 'connected') : [];
		const changed = on ? Object.values(settings.values).filter((entry) => entry.source === 'website').length : 0;
		const problem = broken.map((link) => fill(F.notWorking, { connection: link.label })).join(' · ');
		const docs = (
			<TextLink href={`/docs#feature-${feature.key}`} external>
				{F.docs}
			</TextLink>
		);
		/** @type {FeatureLook['row']} */
		const row = {
			icon: 'zap',
			trailing: (
				<Switch
					size="sm"
					hideLabel
					label={feature.name}
					checked={on}
					locked={!admin}
					lockedLabel={F.locked}
					disabled={blocked}
					onChange={(next) => ask(feature, next)}
				/>
			),
			meta: [
				formatCreditsPerHour(feature.millicreditsPerHour, { locale }),
				...(changed > 0 ? [fill(texts.settings.changed, { count: changed })] : []),
			],
			...(broken.length > 0
				? { status: /** @type {const} */ ('attention'), statusLabel: F.needsSetup, warning: { text: problem } }
				: blocked
					? { warning: { text: fill(F.needsOn, { features: namesOf(missing) }) } }
					: admin
						? {}
						: {
								status: on ? /** @type {const} */ ('success') : /** @type {const} */ ('neutral'),
								statusLabel: on ? F.on : F.off,
							}),
			info: (
				<>
					{feature.description} {docs}
				</>
			),
		};
		if (on)
			return {
				row,
				...(broken.length > 0
					? {
							lead: (
								<>
									{broken.map((link) => (
										<NextStep
											key={link.name}
											tone="warning"
											icon="plug"
											action={
												link.managed
													? {
															label: `${F.connect} ${link.label}`,
															// the database, the storage and the links are set in the Portal
															href: websiteSettingsUrl({
																portal,
																admin,
																websiteId,
																merchantId,
																section: link.kind === 'link' ? 'links' : 'connections',
															}),
														}
													: {
															label: `${F.connect} ${link.label}`,
															// the Connections tab opens on this connection
															onClick: () => open?.('developers', `connection-${link.name}`),
														}
											}>
											{fill(F.notWorking, { connection: link.label })}
										</NextStep>
									))}
								</>
							),
						}
					: {}),
			};
		return {
			row,
			off: true,
			lead: (
				<>
					{feature.description ? <p className="text-sm text-muted">{feature.description}</p> : null}
					{!admin ? (
						<NextStep icon="lock">{fill(F.askSupport, { contact: supportContact(support) })}</NextStep>
					) : blocked ? (
						<NextStep tone="warning" icon="alert">
							{fill(F.needsOn, { features: namesOf(missing) })}
						</NextStep>
					) : (
						<NextStep icon="zap" action={{ label: F.switchOn, onClick: () => ask(feature, true) }}>
							{fill(F.switchOnHint, { name: feature.name })}
						</NextStep>
					)}
					<p className="text-sm">{docs}</p>
				</>
			),
		};
	};
}
