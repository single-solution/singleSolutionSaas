import './site.css';

/**
 * Public marketing site on the Portal (same origin as /login and the console). Unframed.
 * One Unite kit with console + products: `@ss/ui/theme.css` via root `globals.css`.
 * `site.css` is marketing composition only — no parallel colors/radii/faces.
 * @param {{ children: import('react').ReactNode }} props
 */
export default function SiteLayout({ children }) {
	return <div className="ss-site bg-canvas text-fg font-sans">{children}</div>;
}
