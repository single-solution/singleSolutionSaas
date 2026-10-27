import './site.css';

/**
 * Public marketing site on the Portal (same origin as /login and the console). Unframed.
 * Faces and color tokens come from the root layout + `@ss/ui/theme.css` — site.css is layout only.
 * @param {{ children: import('react').ReactNode }} props
 */
export default function SiteLayout({ children }) {
	return <div className="ss-site">{children}</div>;
}
