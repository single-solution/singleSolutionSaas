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
import { Callout, TextLink } from '@ss/ui';
import { SettingsTab as SharedSettingsTab, fill, useLoad } from '@ss/ui/dashboard';
import {
	AttachmentKindsEditor,
	ClaimKindsEditor,
	ClaimStatusesEditor,
	ReasonsEditor,
	ReviewQuestionsEditor,
} from './merchant-lists.js';
import { DEFAULT_CURRENCY, SEARCH_INDEX } from '../../core/limits.js';
import { GradesEditor } from './grades.js';
import { ItemTypesEditor } from './item-types.js';
import { OrderFlowEditor } from './flow-editor.js';
import {
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
import { StoreDetailsView } from './store-details.js';
import { TEXTS } from './texts.js';

/** @typedef {import('@ss/ui/dashboard').FeatureSettings} FeatureSettings */

/**
 * The notice on a feature's settings card: with the `catalog` setting `search` at `atlas` (saved or being edited), the index Atlas Search needs and where the docs explain it (E14, SF-13).
 * @param {string} key the feature
 * @param {Record<string, unknown>} values its settings, edits included
 * @returns {import('react').ReactNode}
 */
export const settingsNotice = (key, values) =>
	key === 'catalog' && values.search === 'atlas' ? (
		<Callout
			tone="info"
			className="mb-4"
			actions={
				<TextLink className="text-sm" href="/docs#atlas-search">
					{TEXTS.settings.atlasDocs}
				</TextLink>
			}>
			{fill(TEXTS.settings.atlasNotice, { index: SEARCH_INDEX })}
		</Callout>
	) : null;

/**
 * The settings a grade's glossary page preview takes (R7 #105): the title pattern and default description of `seo`, the
 * website's name and share image (the Portal's), and the grade patterns of `landing_pages`.
 * @param {FeatureSettings[]} features @param {import('@ss/contracts').WebsiteSettings | null} website
 * @returns {import('./grades.js').GradePreview}
 */
const gradePreview = (features, website) => {
	/** @param {string} key @param {string} name */
	const value = (key, name) => String(features.find((feature) => feature.key === key)?.values[name]?.value ?? '');
	return {
		titleTemplate: value('seo', 'titleTemplate'),
		// the site name and the share picture are the website's, set once in the Portal
		siteName: website?.business.name ?? '',
		defaultDescription: value('seo', 'defaultDescription'),
		defaultImage: website?.brand.files.shareImage ?? '',
		gradeTitle: value('landing_pages', 'gradeTitle'),
		gradeDescription: value('landing_pages', 'gradeDescription'),
	};
};

/**
 * The shop's currency (the Portal's Region and format; USD until it is set), the website's settings and every feature's
 * settings, from the answers the tab reads.
 * @param {string} websiteId
 */
const useShop = (websiteId) => {
	const settings = useLoad(`/v1/dashboard/websites/${websiteId}/settings`);
	const website = useLoad(`/v1/dashboard/websites/${websiteId}/website-settings`);
	/** @type {FeatureSettings[]} */
	const features = settings.answer?.ok ? settings.answer.data.features : [];
	/** @type {import('@ss/contracts').WebsiteSettings | null} */
	const portal = website.answer?.ok ? website.answer.data.settings : null;
	return { currency: portal?.region.currency || DEFAULT_CURRENCY, website: portal, features };
};

/** The grades, with a preview of the glossary page they make. @param {{ websiteId: string }} props */
function Grades({ websiteId }) {
	const { features, website } = useShop(websiteId);
	return <GradesEditor websiteId={websiteId} off={false} bare preview={gradePreview(features, website)} />;
}

/**
 * An editor that needs the shop's currency.
 * @param {{ websiteId: string, bare?: boolean,
 *   editor: (props: { websiteId: string, off: boolean, bare: boolean, currency: string }) => import('react').ReactNode }} props
 *   `bare`: the editor is the whole page, so its card has no title
 */
function WithCurrency({ websiteId, bare = false, editor }) {
	const { currency } = useShop(websiteId);
	return editor({ websiteId, off: false, bare, currency });
}

/**
 * The shop's list editors, each under its feature (a feature that is off is not listed). The ones of Cart and checkout
 * are listed beside it (`top`), as they are many.
 * @param {import('@ss/ui/dashboard').TabProps} props the tab's props (the website, the viewer and the Portal's address)
 * @returns {Record<string, import('@ss/ui/dashboard').FeatureExtra>}
 */
const extrasOf = (props) => {
	const websiteId = String(props.websiteId);
	const { portal, who, merchantId } = props;
	const L = TEXTS.lists;
	return {
		store_details: (
			<StoreDetailsView
				websiteId={websiteId}
				off={false}
				portal={portal}
				admin={who.kind === 'admin'}
				merchantId={merchantId ?? null}
			/>
		),
		catalog: {
			items: [
				{ id: 'item-types', label: L.itemTypes.title, content: <ItemTypesEditor websiteId={websiteId} off={false} bare /> },
			],
		},
		bookings: <BookingSchedulesEditor websiteId={websiteId} off={false} />,
		grades_serials: {
			items: [
				{ id: 'grades', label: L.grades.title, content: <Grades websiteId={websiteId} /> },
				{
					id: 'unit-states',
					label: L.unitStates.title,
					content: <UnitStatesEditor websiteId={websiteId} off={false} bare />,
				},
			],
		},
		checkout: {
			items: [
				{
					id: 'payment-methods',
					label: L.paymentMethods.title,
					top: true,
					content: <WithCurrency websiteId={websiteId} bare editor={(props) => <PaymentMethodsEditor {...props} />} />,
				},
				{
					id: 'order-flow',
					label: L.orderFlow.title,
					top: true,
					content: <OrderFlowEditor websiteId={websiteId} off={false} bare />,
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
				{
					id: 'couriers',
					label: L.couriers.title,
					top: true,
					content: <CouriersEditor websiteId={websiteId} off={false} bare />,
				},
				{
					id: 'policies',
					label: L.policies.title,
					top: true,
					content: <PoliciesEditor websiteId={websiteId} off={false} bare />,
				},
				{
					id: 'segments',
					label: L.segments.title,
					top: true,
					content: <WithCurrency websiteId={websiteId} bare editor={(props) => <SegmentsEditor {...props} />} />,
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
	return <SharedSettingsTab {...props} notice={settingsNotice} extras={extrasOf(props)} />;
}
