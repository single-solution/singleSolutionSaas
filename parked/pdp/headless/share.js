/**
 * Mode B core of the `share` element: share links for the configured channels (device share sheet, copy link, and
 * the networks' public share pages), with optional UTM tagging per channel.
 * @module
 */
import { absolute } from '../core/jsonld.js';
import { SHARE_CHANNELS, shareHref, shareTarget } from '../core/page.js';
import { bool, someOf, text } from '../core/util.js';
import { createItemElement, fail, instance, ok } from './base.js';

/** @param {Record<string, unknown>} config */
export const shareSettings = (config) => ({
	channels: someOf(config.channels, SHARE_CHANNELS, ['native', 'copy', 'whatsapp', 'facebook', 'x', 'email']),
	utm: bool(config.utm, false),
});

/**
 * @param {import('./base.js').ElementOptions} options
 */
export const createShare = (options) => {
	const settings = shareSettings(options.config ?? {});
	let pageUrl = '';
	/** @param {import('../core/item.js').Item | null} item */
	const build = (item) => {
		const url = absolute(item?.url ?? '', pageUrl) || absolute(pageUrl, '');
		const title = item?.title ?? '';
		const image = absolute(item?.images.find((entry) => entry.type === 'image')?.src ?? '', pageUrl);
		return {
			url,
			title,
			links: Object.freeze(
				url === ''
					? []
					: settings.channels.map((channel) => {
							const target = shareTarget(url, channel, settings.utm);
							return Object.freeze({
								channel,
								url: target,
								href: shareHref(channel, { url: target, text: title, image }),
							});
						}),
			),
		};
	};
	const core = createItemElement({
		...options,
		prefix: 'share',
		extra: { ...settings, ...build(null), copied: false },
		usable: () => true,
		derive: build,
	});
	const { store } = core;
	const actions = {
		...core.actions,
		/** @param {import('./base.js').ItemSource} [source] */
		load: (source = {}) => {
			pageUrl = text(source.context?.url, 2048);
			return core.actions.load(source);
		},
		/**
		 * The visitor shared through a channel: returns the link to share.
		 * @param {string} channel
		 * @returns {Promise<import('./base.js').Result<{ channel: string, url: string, href: string, title: string }>>}
		 */
		share: async (channel) => {
			const link = store.get().links.find((entry) => entry.channel === channel);
			if (!link) return fail('channel_unavailable');
			core.emit('shared', { channel });
			return ok({ ...link, title: store.get().title });
		},
		/**
		 * The copy-link channel finished (`true` = copied).
		 * @param {boolean} copied
		 */
		copied: async (copied) => {
			store.set({ copied });
			return ok(copied);
		},
	};
	return instance({ ...core, actions, strings: options.strings ?? {} });
};
