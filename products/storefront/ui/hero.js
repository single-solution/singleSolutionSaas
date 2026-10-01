/**
 * Mode A renderer of `hero`: headline, text and calls to action over (or beside) the media, in a reserved height so
 * nothing shifts. The image is the LCP candidate (eager, high priority, mobile source). A background video is only
 * attached when `chooseMedia` allows it for this visitor (no Save-Data, no slow connection, no reduced motion, wide
 * enough) — never in the HTML: the source is set after the page has loaded and is idle, and only while the hero is
 * near the viewport; it is muted, inline, paused off screen, and has a visible pause button. Otherwise the poster
 * stays.
 */
import { chooseMedia } from '../headless/hero.js';
import { createTranslator } from '../headless/strings.js';
import { el, memo, reduced, windowOf } from './dom.js';

/**
 * After `load` and an idle moment.
 * @param {any} win
 * @param {() => void} run
 */
const whenIdle = (win, run) => {
	const idle = () =>
		typeof win.requestIdleCallback === 'function' ? win.requestIdleCallback(run, { timeout: 3000 }) : win.setTimeout(run, 200);
	if (win.document?.readyState === 'complete') idle();
	else win.addEventListener('load', idle, { once: true });
};

/**
 * @param {any} win
 * @param {any} video
 * @param {string} src
 * @param {(playing: boolean) => void} onPlaying
 */
const attachVideo = (win, video, src, onPlaying) => {
	let near = typeof win.IntersectionObserver !== 'function';
	let ready = false;
	const play = () => {
		const promise = video.play?.();
		promise?.catch?.(() => undefined);
	};
	const attach = () => {
		if (!ready || !near || video.getAttribute('src')) return;
		video.setAttribute('src', src);
		play();
	};
	if (!near) {
		new win.IntersectionObserver(
			(/** @type {any[]} */ entries) => {
				near = entries.some((entry) => entry.isIntersecting);
				if (!video.getAttribute('src')) attach();
				else if (near && !video.hasAttribute('data-paused')) play();
				else video.pause?.();
			},
			{ rootMargin: '200px 0px' },
		).observe(video);
	}
	video.addEventListener('playing', () => {
		video.classList?.add('is-on');
		onPlaying(true);
	});
	whenIdle(win, () => {
		ready = true;
		attach();
	});
};

/**
 * @param {{ state: ReturnType<ReturnType<typeof import('../headless/hero.js').createHero>['state']>,
 *   actions: ReturnType<typeof import('../headless/hero.js').createHero>['actions'], strings: Record<string, string>,
 *   dom: import('./dom.js').DomLike, slots?: Record<string, any>, reducedMotion?: boolean }} props
 */
export const render = ({ state, actions, strings, dom, slots = {}, reducedMotion }) => {
	const t = createTranslator(strings);
	const win = windowOf(dom);
	const local = memo(actions);
	const connection = win?.navigator?.connection ?? {};
	const media = chooseMedia(state, {
		saveData: connection.saveData === true,
		effectiveType: typeof connection.effectiveType === 'string' ? connection.effectiveType : undefined,
		reducedMotion: reduced(win, reducedMotion),
		width: typeof win?.innerWidth === 'number' ? win.innerWidth : undefined,
	});
	const still = state.image.src ?? media.poster;
	const picture = still
		? el(dom, 'picture', { class: 'ss-hero__media' }, [
				state.image.mobile ? el(dom, 'source', { media: '(max-width: 767px)', srcset: state.image.mobile }) : null,
				el(dom, 'img', {
					src: still,
					alt: t('hero.image_alt'),
					loading: state.image.priority ? 'eager' : 'lazy',
					fetchpriority: state.image.priority ? 'high' : null,
					decoding: 'async',
				}),
			])
		: null;
	const video =
		media.video && win
			? (local.video ??
				el(dom, 'video', {
					class: 'ss-hero__video',
					muted: true,
					loop: true,
					playsinline: true,
					preload: 'none',
					poster: media.poster,
					'aria-hidden': 'true',
					tabindex: '-1',
					disablepictureinpicture: true,
				}))
			: null;
	if (video && !local.video) {
		local.video = video;
		video.muted = true;
	}
	const toggle = video
		? el(
				dom,
				'button',
				{
					type: 'button',
					class: 'ss-hero__pause',
					onclick: () => {
						const playing = !state.playing;
						if (playing) {
							video.removeAttribute('data-paused');
							video.play?.()?.catch?.(() => undefined);
						} else {
							video.setAttribute('data-paused', '');
							video.pause?.();
						}
						void actions.setPlaying(playing);
					},
				},
				[t(state.playing ? 'hero.pause' : 'hero.play')],
			)
		: null;
	/** @param {string | null} href @param {'primary' | 'secondary'} which @param {string} key */
	const cta = (href, which, key) =>
		href
			? el(dom, 'a', { href, class: `ss-hero__cta ss-hero__cta--${which}`, onclick: () => void actions.follow(which) }, [
					t(key),
				])
			: null;
	const headline = t('hero.headline');
	const text = t('hero.text');
	const root = el(
		dom,
		'section',
		{ class: `ss-hero ss-hero--${state.layout} ss-hero--${state.height}`, role: 'region', 'aria-label': t('hero.label') },
		[
			picture,
			video,
			el(dom, 'div', { class: 'ss-hero__body' }, [
				slots.before ?? null,
				headline && headline !== 'hero.headline' ? el(dom, 'h2', { class: 'ss-hero__title' }, [headline]) : null,
				text && text !== 'hero.text' ? el(dom, 'p', { class: 'ss-hero__text' }, [text]) : null,
				el(dom, 'div', { class: 'ss-hero__actions' }, [
					cta(state.cta, 'primary', 'hero.cta'),
					cta(state.secondary, 'secondary', 'hero.secondary'),
				]),
				slots.after ?? null,
			]),
			toggle,
		],
	);
	if (video && media.video && !local.attached) {
		local.attached = true;
		attachVideo(win, video, media.video, (playing) => void actions.setPlaying(playing));
	}
	return root;
};

export const styles = `.ss-hero{position:relative;display:grid;overflow:hidden;color:var(--ss-color-text);background:var(--ss-color-surface-2);border-radius:var(--ss-radius-lg);font:var(--ss-font-body)}
.ss-hero--sm{min-height:clamp(12rem,30vh,18rem)}.ss-hero--md{min-height:clamp(16rem,45vh,28rem)}.ss-hero--lg{min-height:clamp(20rem,70vh,40rem)}
.ss-hero__media,.ss-hero__video{grid-area:1/1;width:100%;height:100%}.ss-hero__media img,.ss-hero__video{width:100%;height:100%;object-fit:cover;display:block}
.ss-hero__video{opacity:0;transition:opacity var(--ss-motion-duration,600ms)}.ss-hero__video.is-on{opacity:1}
.ss-hero__body{grid-area:1/1;position:relative;align-self:end;display:flex;flex-direction:column;gap:var(--ss-space-2);padding:var(--ss-space-6,1.5rem);max-width:40rem}
.ss-hero--overlay .ss-hero__body{background:var(--ss-color-surface);margin:var(--ss-space-4);border-radius:var(--ss-radius-md)}
.ss-hero--centered .ss-hero__body{align-self:center;justify-self:center;text-align:center;align-items:center;background:var(--ss-color-surface);border-radius:var(--ss-radius-md)}
@media (min-width:768px){.ss-hero--split{grid-template-columns:1fr 1fr}.ss-hero--split .ss-hero__media,.ss-hero--split .ss-hero__video{grid-area:1/2}.ss-hero--split .ss-hero__body{grid-area:1/1;align-self:center}}
.ss-hero__title{margin:0;font:var(--ss-font-heading,inherit);font-size:clamp(1.5rem,4vw,2.75rem);font-weight:var(--ss-font-weight-bold,700)}.ss-hero__text{margin:0}
.ss-hero__actions{display:flex;flex-wrap:wrap;gap:var(--ss-space-2)}
.ss-hero__cta{display:inline-flex;align-items:center;min-height:2.75rem;padding:0 var(--ss-space-4);border-radius:var(--ss-radius-full);text-decoration:none;font-weight:var(--ss-font-weight-bold,600)}
.ss-hero__cta--primary{background:var(--ss-color-primary);color:var(--ss-color-on-primary)}.ss-hero__cta--secondary{border:1px solid var(--ss-color-border);color:var(--ss-color-text);background:var(--ss-color-surface)}
.ss-hero__pause{position:absolute;right:var(--ss-space-2);bottom:var(--ss-space-2);min-height:2.75rem;padding:0 var(--ss-space-3);border:1px solid var(--ss-color-border);border-radius:var(--ss-radius-full);background:var(--ss-color-surface);color:var(--ss-color-text);font:inherit}
.ss-hero a:focus-visible,.ss-hero button:focus-visible{outline:2px solid var(--ss-color-focus);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.ss-hero__video{display:none}}
`;
