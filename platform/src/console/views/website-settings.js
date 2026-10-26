'use client';
/**
 * Website settings: the facts every product of a website shares, kept once in the Portal (settings-ownership design,
 * section 8.1). They are sub-pages of the website's own page (`website-page.js`): Business, Brand and look, Region and
 * format, Domains, pages and legal, Team and alerts, Data and files, Between your products - one section at a time, forms
 * on the shared components, nested things in right drawers and the floating Save bar - and Recent changes (a table).
 * This module holds the state they share (the saved document, what the products still need from it, the changes, what
 * is set under Data and files) and draws one section. A save names the version the person read; if someone saved
 * meanwhile the page offers a reload. The Portal checks every right and value again.
 * @module
 */
import { useEffect, useState } from 'react';
import { CardFlow, describeProblem, useToast } from '@ss/ui';
import { WEBSITE_SETTINGS as T } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { api } from '../paths.js';
import { ConnectionsSection, LinksSection } from './website-connections.js';
import { BrandSection, BusinessSection, PagesSection, RegionSection, TeamSection } from './website-settings-sections.js';

/** @typedef {import('@ss/contracts').WebsiteSettings} WebsiteSettings */
/** @typedef {{ productId: string, name: string, requires: string[], missing: string[] }} Readiness */
/** @typedef {{ at: string, section: string, version: number, changed: string[], who: { type: string, name: string | null } }} Change */

/** The sections that are the settings document (the rest is Data and files, and the links). */
const DOCUMENT_SECTIONS = ['business', 'brand', 'region', 'pages', 'team'];

/** The section a missing value belongs to: `region.currency` is in `region`. @param {string} path */
const sectionOfPath = (path) => path.split('.')[0] ?? '';

/**
 * The words for what a product still needs: `currency, country`.
 * @param {string[]} paths
 */
const needs = (paths) => paths.map((path) => /** @type {Record<string, string>} */ (T.paths)[path] ?? path).join(', ');

/**
 * What the products ask the settings to say that is still empty, as a line each; empty when nothing is missing.
 * @param {Readiness[]} readiness
 */
export const readinessLines = (readiness) =>
	readiness.filter((item) => item.missing.length > 0).map((item) => T.readyMissing(item.name, needs(item.missing)));

/**
 * What the products still need from a section, as a dot for its link in the inner navigation and who needs it.
 * @param {Readiness[]} readiness
 * @param {string} section
 */
export const contextOf = (readiness, section) => {
	const waiting = readiness.filter((item) => item.missing.some((path) => sectionOfPath(path) === section));
	return waiting.length === 0
		? {}
		: { dot: /** @type {const} */ ('warning'), dotLabel: T.needsSetup(waiting.map((item) => item.name).join(', ')) };
};

/**
 * The state the settings sub-pages share, kept by the website page so its header and navigation show it too.
 * @param {{ data: { settings: WebsiteSettings, readiness: Readiness[], can: { write: boolean } } | null, changes: Change[],
 *   connections: import('./website-connections.js').ConnectionsView | null, merchantId: string, websiteId: string }} props
 */
export function useWebsiteSettings({ data, changes: initialChanges, connections: initialConnections, merchantId, websiteId }) {
	const toast = useToast();
	const [settings, setSettings] = useState(data?.settings ?? null);
	const [readiness, setReadiness] = useState(data?.readiness ?? []);
	const [changes, setChanges] = useState(initialChanges);
	const [connections, setConnections] = useState(initialConnections);
	const [stale, setStale] = useState(false);
	useEffect(() => {
		setSettings(data?.settings ?? null);
		setReadiness(data?.readiness ?? []);
	}, [data]);
	useEffect(() => setChanges(initialChanges), [initialChanges]);
	useEffect(() => setConnections(initialConnections), [initialConnections]);

	const loadChanges = async () => {
		const result = await apiFetch(api.websiteSettingsChanges(merchantId, websiteId));
		if (result.ok) setChanges(result.data.items);
	};
	/** @param {{ settings: WebsiteSettings, readiness: Readiness[] }} answer */
	const saved = (answer) => {
		setSettings(answer.settings);
		setReadiness(answer.readiness);
		setStale(false);
		void loadChanges();
	};
	const reload = async () => {
		const result = await apiFetch(api.websiteSettings(merchantId, websiteId));
		if (!result.ok) {
			toast.show({ tone: 'danger', title: describeProblem(result.problem) });
			return;
		}
		saved(result.data);
		toast.show({ title: T.reloaded });
	};
	return {
		settings,
		readiness,
		changes,
		connections,
		setConnections,
		stale,
		canWrite: data?.can.write ?? false,
		manage: { merchantId, websiteId },
		saved,
		markStale: () => setStale(true),
		reload: () => void reload(),
	};
}

/**
 * One section of the settings.
 * @param {{ section: string, state: ReturnType<typeof useWebsiteSettings>, twoStepOn?: boolean }} props
 */
export function SettingsSectionBody({ section, state, twoStepOn = false }) {
	const { settings, manage, canWrite, stale, saved, markStale, reload, connections, setConnections } = state;
	if (DOCUMENT_SECTIONS.includes(section) && !settings) return null;
	const common = {
		settings: /** @type {WebsiteSettings} */ (settings),
		manage,
		canWrite,
		stale,
		onSaved: saved,
		onStale: markStale,
		onReload: reload,
	};
	return (
		<CardFlow>
			{section === 'business' ? <BusinessSection {...common} /> : null}
			{section === 'brand' ? <BrandSection {...common} /> : null}
			{section === 'region' ? <RegionSection {...common} /> : null}
			{section === 'pages' ? <PagesSection {...common} /> : null}
			{section === 'team' ? <TeamSection {...common} /> : null}
			{section === 'connections' ? (
				<ConnectionsSection
					view={connections}
					manage={manage}
					canWrite={connections?.can.write ?? false}
					twoStepOn={twoStepOn}
					onChanged={(view) => setConnections(view)}
				/>
			) : null}
			{section === 'links' ? (
				<LinksSection
					view={connections}
					manage={manage}
					canWrite={connections?.can.write ?? false}
					twoStepOn={twoStepOn}
					onChanged={(view) => setConnections(view)}
				/>
			) : null}
		</CardFlow>
	);
}
