'use client';
/**
 * Settings tab (PLAN 0.4.3, 0.8.8): the kit's settings of the switched-on features, listed by category in the inner
 * sidebar (Products, Orders and checkout, Marketing, Shopper features, Search and SEO, Admin tools), with the shop's
 * list editors under the feature they belong to: item types under Catalog; grades and unit states; the payment methods,
 * address regions, order flow, reasons, couriers, policies and customer segments beside Cart and checkout; delivery
 * zones and rates; tax rules; role prices; review questions; claim kinds and statuses. Every editor shows one entry at
 * a time. Forms are rendered from the schemas the settings API returns; a feature with many groups lists them as
 * sub-items. The widget texts, theme and Format are the Texts and Theme & format tabs. Defaults uses the same features
 * for the global defaults.
 * @module
 */
import { Callout } from '@ss/ui';
import { SettingsTab as SharedSettingsTab, fill, useLoad } from '@ss/ui/dashboard';
import {
	AttachmentKindsEditor,
	ClaimKindsEditor,
	ClaimStatusesEditor,
	ReasonsEditor,
	ReviewQuestionsEditor,
} from './merchant-lists.js';
import { GradesEditor } from './grades.js';
import { ItemTypesEditor } from './item-types.js';
import { OrderFlowEditor } from './flow-editor.js';
import {
	AddressRegionsEditor,
	BookingSchedulesEditor,
	CouriersEditor,
	PoliciesEditor,
	RolePricesEditor,
	SegmentsEditor,
	TaxRulesEditor,
	UnitStatesEditor,
	ZonesEditor,
} from './lists.js';
import { PaymentMethodsEditor } from './payment-methods.js';
import { StoreDetailsEditor } from './store-details.js';
import { TEXTS } from './texts.js';

/** @typedef {import('@ss/ui/dashboard').FeatureSettings} FeatureSettings */

/**
 * The notice on a feature's settings card: with the `catalog` setting `search` or `chatSearch` at `atlas` (saved or
 * being edited), the index Atlas Search needs and where the docs explain it (E14, SF-13).
 * @param {string} key the feature
 * @param {Record<string, unknown>} values its settings, edits included
 * @returns {import('react').ReactNode}
 */
export const settingsNotice = (key, values) =>
	key === 'catalog' && (values.search === 'atlas' || values.chatSearch === 'atlas') ? (
		<Callout
			tone="info"
			className="mb-4"
			actions={
				<a className="text-sm font-semibold text-primary hover:underline" href="/docs#atlas-search">
					{TEXTS.settings.atlasDocs}
				</a>
			}>
			{fill(TEXTS.settings.atlasNotice, { index: String(values.searchIndex ?? '') })}
		</Callout>
	) : null;

/**
 * The settings a grade's glossary page preview takes (R7 #105): the title pattern, brand name, default description and
 * share image of `seo`, and the grade patterns of `landing_pages`.
 * @param {FeatureSettings[]} features
 * @returns {import('./grades.js').GradePreview}
 */
const gradePreview = (features) => {
	/** @param {string} key @param {string} name */
	const value = (key, name) => String(features.find((feature) => feature.key === key)?.values[name]?.value ?? '');
	return {
		titleTemplate: value('seo', 'titleTemplate'),
		siteName: value('seo', 'brandName'),
		defaultDescription: value('seo', 'defaultDescription'),
		defaultImage: value('seo', 'defaultImage'),
		gradeTitle: value('landing_pages', 'gradeTitle'),
		gradeDescription: value('landing_pages', 'gradeDescription'),
	};
};

/**
 * The shop's currency (the Catalog setting) and every feature's settings, from the settings answer the tab has already
 * read.
 * @param {string} websiteId
 */
const useShop = (websiteId) => {
	const settings = useLoad(`/v1/dashboard/websites/${websiteId}/settings`);
	/** @type {FeatureSettings[]} */
	const features = settings.answer?.ok ? settings.answer.data.features : [];
	return {
		currency: String(features.find((feature) => feature.key === 'catalog')?.values.currency?.value ?? ''),
		features,
	};
};

/** The grades, with a preview of the glossary page they make. @param {{ websiteId: string }} props */
function Grades({ websiteId }) {
	const { features } = useShop(websiteId);
	return <GradesEditor websiteId={websiteId} off={false} preview={gradePreview(features)} />;
}

/**
 * An editor that needs the shop's currency.
 * @param {{ websiteId: string, editor: (props: { websiteId: string, off: boolean, currency: string }) => import('react').ReactNode }} props
 */
function WithCurrency({ websiteId, editor }) {
	const { currency } = useShop(websiteId);
	return editor({ websiteId, off: false, currency });
}

/**
 * The shop's list editors, each under its feature (a feature that is off is not listed). The ones of Cart and checkout
 * are listed beside it (`top`), as they are many.
 * @param {string} websiteId
 * @returns {Record<string, import('@ss/ui/dashboard').FeatureExtra>}
 */
const extrasOf = (websiteId) => {
	const L = TEXTS.lists;
	return {
		store_details: <StoreDetailsEditor websiteId={websiteId} off={false} />,
		catalog: {
			items: [{ id: 'item-types', label: L.itemTypes.title, content: <ItemTypesEditor websiteId={websiteId} off={false} /> }],
		},
		bookings: <BookingSchedulesEditor websiteId={websiteId} off={false} />,
		grades_serials: {
			items: [
				{ id: 'grades', label: L.grades.title, content: <Grades websiteId={websiteId} /> },
				{ id: 'unit-states', label: L.unitStates.title, content: <UnitStatesEditor websiteId={websiteId} off={false} /> },
			],
		},
		checkout: {
			items: [
				{
					id: 'payment-methods',
					label: L.paymentMethods.title,
					top: true,
					content: <WithCurrency websiteId={websiteId} editor={(props) => <PaymentMethodsEditor {...props} />} />,
				},
				{
					id: 'address-regions',
					label: L.addressRegions.title,
					top: true,
					content: <AddressRegionsEditor websiteId={websiteId} off={false} />,
				},
				{
					id: 'order-flow',
					label: L.orderFlow.title,
					top: true,
					content: <OrderFlowEditor websiteId={websiteId} off={false} />,
				},
				{
					id: 'reasons',
					label: 'Reasons and files',
					top: true,
					content: (
						<>
							<ReasonsEditor websiteId={websiteId} off={false} list="cancel_reasons" />
							<ReasonsEditor websiteId={websiteId} off={false} list="delivery_failure_reasons" />
							<AttachmentKindsEditor websiteId={websiteId} off={false} />
						</>
					),
				},
				{ id: 'couriers', label: L.couriers.title, top: true, content: <CouriersEditor websiteId={websiteId} off={false} /> },
				{ id: 'policies', label: L.policies.title, top: true, content: <PoliciesEditor websiteId={websiteId} off={false} /> },
				{
					id: 'segments',
					label: L.segments.title,
					top: true,
					content: <WithCurrency websiteId={websiteId} editor={(props) => <SegmentsEditor {...props} />} />,
				},
			],
		},
		delivery_zones: <WithCurrency websiteId={websiteId} editor={(props) => <ZonesEditor {...props} />} />,
		taxes: <TaxRulesEditor websiteId={websiteId} off={false} />,
		reviews: <ReviewQuestionsEditor websiteId={websiteId} off={false} />,
		returns: (
			<>
				<ClaimKindsEditor websiteId={websiteId} off={false} />
				<ClaimStatusesEditor websiteId={websiteId} off={false} />
			</>
		),
		role_pricing: <WithCurrency websiteId={websiteId} editor={(props) => <RolePricesEditor {...props} />} />,
	};
};

/** @param {import('@ss/ui/dashboard').TabProps} props */
export function SettingsTab(props) {
	return <SharedSettingsTab {...props} notice={settingsNotice} extras={extrasOf(String(props.websiteId))} />;
}
