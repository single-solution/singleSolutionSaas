import './site.css';

/**
 * Public marketing site on the Portal (same origin as /login and the console). Unframed.
 * Theme pack: Unite (`@ss/ui/theme.css` via root `globals.css`) — same pack as Docs, console, products.
 * See `packages/ui/THEME-PACK.md`. `site.css` is home composition only — no parallel palette.
 * @param {{ children: import('react').ReactNode }} props
 */
export default function SiteLayout({ children }) {
	return <div className="ss-site bg-canvas text-fg font-sans">{children}</div>;
}
