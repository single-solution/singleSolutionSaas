'use client';

import { useEffect, useState } from 'react';
import NextLink from 'next/link.js';
import { usePathname } from 'next/navigation.js';

const Link = /** @type {any} */ (NextLink);

import { COMPANY_NAME, PRODUCT_BRAND } from './brand.js';

export { COMPANY_NAME, PRODUCT_BRAND };

/**
 * Shared floating glass header for the public Portal surface (Website + Docs).
 * @param {{ brandName?: string, isHome?: boolean }} props
 */
export function SiteHeader({ brandName = PRODUCT_BRAND, isHome = false }) {
	const rawPath = usePathname();
	const pathname = rawPath || (isHome ? '/' : '');
	const [scrolled, setScrolled] = useState(false);

	useEffect(() => {
		const onScroll = () => setScrolled(window.scrollY > 12);
		onScroll();
		window.addEventListener('scroll', onScroll, { passive: true });
		return () => window.removeEventListener('scroll', onScroll);
	}, []);

	const isCurrentHome = isHome || pathname === '/';
	const isDocs = pathname === '/docs' || pathname.startsWith('/docs/');

	return (
		<div className={`nav-shell${scrolled ? ' is-scrolled' : ''}`}>
			<header className="nav glass">
				<Link className="brand" href={isCurrentHome ? '#top' : '/'}>
					{brandName}
				</Link>
				<nav aria-label="Main">
					<a href={isCurrentHome ? '#products' : '/#products'}>Features</a>
					<Link href="/docs" style={isDocs ? { color: 'var(--ss-primary)', fontWeight: 600 } : undefined}>
						Docs
					</Link>
				</nav>
				<Link className="cta" href="/login">
					Sign in
				</Link>
			</header>
		</div>
	);
}

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
