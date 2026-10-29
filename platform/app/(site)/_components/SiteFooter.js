'use client';

import NextLink from 'next/link.js';
import { COMPANY_NAME, PRODUCT_BRAND } from './brand-constants.js';

const Link = /** @type {any} */ (NextLink);

/**
 * Shared footer for the public Portal surface (Website + Docs).
 * @param {{ brandName?: string, companyName?: string, isHome?: boolean }} props
 */
export function SiteFooter({ brandName = PRODUCT_BRAND, companyName = COMPANY_NAME, isHome = false }) {
	return (
		<footer>
			<div>
				<strong>{brandName}</strong>
				<span className="by">by {companyName}</span>
			</div>
			<nav aria-label="Footer">
				<a href={isHome ? '#products' : '/#products'}>Features</a>
				<Link href="/docs">Docs</Link>
				<Link href="/login">Sign in</Link>
			</nav>
		</footer>
	);
}
