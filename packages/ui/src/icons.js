/**
 * Inline SVG icons (24 × 24 stroke icons, `currentColor`). Decorative by default (`aria-hidden`); pass `title` to
 * expose one to assistive technology.
 * @module
 */

const PATHS = Object.freeze({
	lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
	unlock: 'M7 11V7a5 5 0 0 1 9.9-1M5 11h14v10H5z',
	check: 'M5 12l5 5L20 7',
	copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
	close: 'M6 6l12 12M18 6L6 18',
	menu: 'M4 6h16M4 12h16M4 18h16',
	chevronRight: 'M9 6l6 6-6 6',
	chevronDown: 'M6 9l6 6 6-6',
	arrowUp: 'M12 19V5M5 12l7-7 7 7',
	arrowDown: 'M12 5v14M19 12l-7 7-7-7',
	sort: 'M8 9l4-4 4 4M16 15l-4 4-4-4',
	plus: 'M12 5v14M5 12h14',
	alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
	info: 'M12 16v-4M12 8h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
	globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
	grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
	key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z',
	plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',
	activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
	send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
	wallet: 'M3 7h18v13H3zM3 7l3-4h12l3 4M16 14h.01',
	shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
	users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
	user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
	box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
	external: 'M14 3h7v7M10 14L21 3M19 14v6H4V5h6',
	refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
	zap: 'M13 2L3 14h9l-1 8 10-12h-9z',
	logout: 'M9 21H5V3h4M16 17l5-5-5-5M21 12H9',
	sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
	clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
	trash: 'M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15',
	eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
	sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41',
	moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
	monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
	home: 'M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10',
	coins: 'M9 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM15.9 10.1A6 6 0 1 1 10 18M7 6h2v4',
	trendingUp: 'M22 7l-8.5 8.5-5-5L2 17M16 7h6v6',
	calendar: 'M3 5h18v16H3zM16 3v4M8 3v4M3 10h18',
	layers: 'M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5',
	receipt: 'M5 2h14v20l-3-2-2 2-2-2-2 2-2-2-3 2zM9 7h6M9 11h6M9 15h4',
	mail: 'M3 5h18v14H3zM3 5l9 8 9-8',
	store: 'M3 9l2-5h14l2 5M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0zM5 13v8h14v-8M10 21v-5h4v5',
});

/** @typedef {keyof typeof PATHS} IconName */

/**
 * @param {{ name: IconName, size?: number, className?: string, title?: string }} props
 */
export function Icon({ name, size = 16, className, title }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			focusable="false"
			{...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
			{title ? <title>{title}</title> : null}
			<path d={PATHS[name]} />
		</svg>
	);
}

export const ICON_NAMES = /** @type {IconName[]} */ (Object.keys(PATHS));
