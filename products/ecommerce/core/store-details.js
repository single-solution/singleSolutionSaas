/**
 * Store details: who the store is as its customers see it, read from the website's settings in the Portal (Website
 * settings › Business, Brand and look, Region and format; nothing is saved in Ecommerce) — its name and tagline, its
 * pictures (the logo and its dark-mode version, the icon, the favicon and its dark-mode version: https addresses), contact
 * email, phone, more phones with a name each (a landline next to the mobile) and WhatsApp number, postal address
 * (`@ss/contracts/address`), opening hours (the weekly windows and dated exceptions: `{ day 1–7, start, end }` and
 * `{ date, name, hours }`), social links, and the time zone and language its hours and texts follow. Every field is
 * public: a website shows them in its header, footer and contact page, and serves `/.well-known/business.json` from them
 * (`businessJsonOf`). No I/O.
 * @module
 */
import { buildBusinessJson } from '@ss/contracts';
import { addressLines, countryName } from '@ss/contracts/address';

/**
 * A picture of the store: its https address (`url`) from the Portal's Brand and look, with its alternative text.
 * @typedef {{ key: string, type: string, size: number, alt: string, url?: string }} StoreFile
 */
/** @typedef {Record<'line1' | 'line2' | 'area' | 'city' | 'region' | 'postalCode', string> & { country: string }} StoreAddress */
/**
 * @typedef {object} StoreDetails
 * @property {string} name
 * @property {string} tagline
 * @property {StoreFile | null} logo the logo for light backgrounds
 * @property {StoreFile | null} logoDark the logo for dark mode
 * @property {StoreFile | null} icon the square mark of the store (apps, social cards)
 * @property {StoreFile | null} favicon the icon of the browser tab
 * @property {StoreFile | null} faviconDark the browser-tab icon for dark mode
 * @property {string} email
 * @property {string} phone the main phone number
 * @property {Array<{ label: string, number: string }>} phones more phone numbers, each with a name (Landline, Sales …)
 * @property {string} whatsapp
 * @property {StoreAddress} address
 * @property {{ weekly: Array<{ day: number, start: string, end: string }>,
 *   exceptions: Array<{ date: string, name: string, hours: Array<{ start: string, end: string }> }> }} hours
 * @property {Array<{ label: string, url: string }>} social
 * @property {string} timeZone an IANA time zone name, '' when not set
 * @property {string} language a BCP 47 tag, '' when not set
 */

/**
 * The address of the details as the country writes it (`addressLines`), joined by `separator`.
 * @param {StoreAddress} address @param {string} [separator]
 */
export const addressText = (address, separator = ', ') => addressLines(address, address.country).join(separator);

/**
 * A link that opens a WhatsApp chat with the number (`https://wa.me/<digits>`), or '' without a usable number.
 * @param {string} number
 */
export const whatsappLink = (number) => {
	const digits = number.replace(/\D/g, '');
	return digits.length >= 6 && digits.length <= 15 ? `https://wa.me/${digits}` : '';
};

/**
 * A picture as a website reads it: its public address, alternative text and type; null when it is not set.
 * @param {StoreFile | null} file @param {string | null} url
 */
const publicFile = (file, url) => (file && url ? { url, alt: file.alt, type: file.type } : null);

/**
 * The store details as shoppers and websites read them (public; never a storage key): the name (the business name
 * while none is set), tagline, the pictures (logo, dark logo, icon, favicon, dark favicon) with their addresses, contacts
 * (the main phone and the phone list), the address in parts and as lines, the
 * opening hours and social links, and the time zone and language.
 * @param {StoreDetails} details
 * @param {{ logoUrl: string | null, iconUrl: string | null, logoDarkUrl?: string | null, faviconUrl?: string | null,
 *   faviconDarkUrl?: string | null, businessName?: string, siteUrl?: string }} context the public address of each
 *   picture, and the website's own address (its domain; not a setting)
 */
export const publicStoreDetails = (
	details,
	{ logoUrl, iconUrl, logoDarkUrl = null, faviconUrl = null, faviconDarkUrl = null, businessName = '', siteUrl = '' },
) => ({
	name: details.name || businessName,
	tagline: details.tagline,
	logo: publicFile(details.logo, logoUrl),
	logoDark: publicFile(details.logoDark, logoDarkUrl),
	icon: publicFile(details.icon, iconUrl),
	favicon: publicFile(details.favicon, faviconUrl),
	faviconDark: publicFile(details.faviconDark, faviconDarkUrl),
	contact: {
		email: details.email,
		phone: details.phone,
		phones: details.phones,
		whatsapp: details.whatsapp,
		whatsappUrl: whatsappLink(details.whatsapp),
	},
	address: {
		...details.address,
		countryName: details.address.country ? countryName(details.address.country) : '',
		lines: addressLines(details.address, details.address.country),
		text: addressText(details.address),
	},
	hours: { weekly: details.hours.weekly, exceptions: details.hours.exceptions },
	social: details.social,
	timeZone: details.timeZone,
	language: details.language,
	siteUrl,
});

/**
 * The business.json document (`@ss/contracts` business.json version 1) the store details make, for a headless website
 * to serve at `/.well-known/business.json`: the name (the business name while none is set), the logo (its public https
 * address), email, phone (the main one, else the first of the phone list), the address as text, its country, the time zone, the shop currency and the currencies taken
 * and the language. The members with no value are left out. business.json has one logo and one phone: the dark logo,
 * the icon, the favicons and the other phones have no place in it. Fails (`ok: false`) only without any name.
 * @param {StoreDetails} details
 * @param {{ logoUrl?: string | null, currency?: string, currencies?: readonly string[], businessName?: string,
 *   timeZone?: string, language?: string, country?: string }} [context] what the details do not hold
 */
export const businessJsonOf = (details, context = {}) =>
	buildBusinessJson({
		name: details.name || context.businessName,
		logo: context.logoUrl,
		email: details.email,
		phone: details.phone || details.phones[0]?.number,
		address: addressText(details.address, '\n'),
		country: details.address.country || context.country,
		timeZone: details.timeZone || context.timeZone,
		currency: context.currency,
		currencies: context.currencies,
		language: details.language || context.language,
	});

/**
 * The store details the Portal's website settings make (settings-ownership design 8.1). The facts are the Business section, the time zone and language the Region section; the pictures are
 * the https addresses of Brand and look, which have no key in the merchant's storage (`url`).
 * @param {import('@ss/contracts').WebsiteSettings} website
 * @returns {StoreDetails}
 */
export const storeDetailsFromWebsite = (website) => {
	const { business, brand, region } = website;
	/** @param {string} url @param {string} alt @returns {StoreFile | null} */
	const picture = (url, alt) => (url ? { key: '', type: '', size: 0, alt, url } : null);
	return {
		name: business.name,
		tagline: business.tagline,
		logo: picture(brand.files.logo, business.name),
		logoDark: picture(brand.files.logoDark, business.name),
		icon: picture(brand.files.icon, ''),
		favicon: picture(brand.files.favicon, ''),
		faviconDark: picture(brand.files.faviconDark, ''),
		email: business.email,
		phone: business.phone,
		phones: business.phones.map(({ label, number }) => ({ label, number })),
		whatsapp: business.whatsapp,
		address: { ...business.address },
		hours: structuredClone(business.hours),
		social: business.social.map(({ label, url }) => ({ label, url })),
		timeZone: region.timeZone,
		language: region.language,
	};
};
