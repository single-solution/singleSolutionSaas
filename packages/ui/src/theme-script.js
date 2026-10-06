/**
 * `ThemeScript` goes in the document `<head>` (a server component) and sets `data-theme` on `<html>` before the first
 * paint, so a stored Light / Dark choice (`ThemeToggle`) never flashes the other theme. Pass the page's CSP nonce.
 * @module
 */

/** `localStorage` key of the stored choice (absent = follow the system). */
export const THEME_STORAGE_KEY = 'ss-theme';

/** Inline script applying the stored choice before paint (no dependencies; storage errors keep the system theme). */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

/**
 * @param {{ nonce?: string | null }} props the page's CSP nonce, if it has a nonce-based policy
 */
export function ThemeScript({ nonce }) {
	return <script {...(nonce ? { nonce } : {})} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />;
}
