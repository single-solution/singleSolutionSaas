# Product Detail Page — merchant and developer guide

## 1. Describe the item on your page

Every element reads the same item. Give it in any of these ways (later ones win field by field):

1. **`<meta>` tags** — Open Graph and product tags many sites already have (`og:title`, `og:description`, `og:url`,
   `og:image`, `product:price:amount`, `product:price:currency`, `product:availability`, `product:condition`,
   `product:brand`, `product:category`, `product:retailer_item_id`), plus `ss:item-id` and `ss:item:<field>`
   (`<meta name="ss:item:compare-at-price" content="59.90">`).
2. **Attributes on the item's element** — the element with `data-ss-item-id` is the item root:

   ```html
   <main
   	data-ss-item-id="itm_123"
   	data-ss-item-title="Linen shirt"
   	data-ss-item-brand="Acme"
   	data-ss-item-price="49.90"
   	data-ss-item-compare-at-price="59.90"
   	data-ss-item-currency="EUR"
   	data-ss-item-availability="InStock"
   	data-ss-item-condition="New">
   	<img data-ss-item-image src="/img/1.jpg" width="1200" height="1200" alt="" data-ss-zoom="/img/1-2x.jpg" />
   	<video data-ss-item-image poster="/img/v.jpg"><source src="/img/v.mp4" /></video>
   	<div data-ss-slot="gallery"></div>
   	<div data-ss-slot="price"></div>
   	<button data-ss-buy>Add to cart</button>
   </main>
   ```

   Fields: `id title subtitle brand description url sku gtin mpn category condition availability stock price
compare-at-price currency rating rating-count`.

3. **An inline JSON blob** inside the item root (or anywhere): `<script type="application/json" data-ss-item>` with
   the same field names in camelCase plus lists: `images` (`[{ src, alt, width, height, srcset, zoom, type, poster }]`
   or URLs), `faq` (`[{ question, answer }]`), `related` (`[{ id, title, url, image, price, currency, brand,
category }]`), `attributes` (`[{ name, value }]` or an object).
4. **A public JSON source** (`source_url` on each element) — an https URL template with `{id}` (the page's item id),
   `{path}` and, on hosted pages, the route parameters. `source_fields` maps your JSON (dot paths; `root` selects the
   item object), unmapped fields are read from same-named properties. Requests carry no cookies, are capped at 256 KB
   and 8 s, and are shared by every element on the page. Allow the host in your `connect-src` if you use a CSP.

Prices are plain decimals (`1299.50`, no thousands separators) with an ISO 4217 currency. Availability and condition
accept schema.org values (`InStock`, `https://schema.org/UsedCondition`, …). Everything shown is text — the pack never
inserts HTML from your data.

## 2. Place the elements

Each element's `placement` feature defaults to a slot: `[data-ss-slot="gallery"]`, `price`, `configurator`, `deals`,
`grade`, `reviews`, `alerts`, `related`, `faq`, `share`; structured data goes into the item root
(`[data-ss-item-id]`), the sticky bar after `[data-ss-buy]`, the hosted page on `/p/*`. Change paths, selectors,
page types, devices, consent and frequency per element in the console.

## 3. Elements

- **Gallery** — `layout` (carousel, grid, stacked), `aspect_ratio` (reserved before images load: no layout shift),
  `thumbnails`, `max_images`, `zoom`, `video`, `lazy` (`first_eager`: the `priority_index` image loads at once with
  high fetch priority, the others lazily). Alt text: your own `alt` wins unless it only repeats the title; otherwise
  the `gallery.alt` / `gallery.alt_single` strings (`{title}`, `{brand}`, `{index}`, `{total}`). Keyboard: arrow keys,
  Home and End on the viewer, the thumbnails and the zoom dialog; Enter or Space zooms; Escape closes and focus
  returns. Swipe on touch screens.
- **Price block** — `savings` (none, amount, percent, both), `currency_display`, `fraction_digits`, `locale` (empty =
  the page's `lang`), availability, taxes and financing copy (strings). `update_event`: an element event carrying the
  selected variant `{ price, compareAtPrice?, currency?, availability? }`, e.g. `widget.variant_selected`.
- **Structured data** — `Product` + `Offer` JSON-LD from the item: name, description, URL (your canonical link),
  images, SKU, GTIN, MPN, brand, category, condition, rating (only when the page has one), offer price, currency,
  availability, `seller_name`, `price_valid_days`. `condition_map` lists your own condition values for each
  schema.org condition (`refurbished: ["Grade B"]`); `default_condition` covers the rest. `skip_if_present` leaves pages
  that already carry Product markup alone. `track_item_viewed` sends the standard `item.viewed@1`.
- **Embeds** (`configurator_embed`, `deal_pill`, `grade_showcase`, `reviews_block`, `alerts_block`) — while the other
  product is subscribed and its element (`target`) is mounted, its block moves into this slot inside the item, and is
  refreshed for this item (`refresh`). Without that product, nothing renders. They use the Loader's public element
  API only (`SS.elements`, `SS.on`), never the other product's code.
- **Related** — items from the page data or `list_url` (https JSON array or `{ items }`, placeholders `{id}`,
  `{brand}`, `{category}`), narrowed by `strategy` (as given, same brand, same category), `count`, `layout`.
- **FAQ** — questions from the item, your manual `entries`, or both (`source`), `count`, `open_first`,
  `structured_data` (`FAQPage` markup for exactly the visible questions). AI-written answers come from the SEO Suite.
- **Sticky buy bar** — `devices`, `mode` (`after_cta`: once your buy button scrolls out of view; `after_scroll`;
  `always`), `hide_unavailable`, `cta_selector`, `action` (`click` presses your button — your cart logic stays the
  only one — or `scroll` brings it into view), `dismissible`.
- **Share** — `channels` (device share sheet and copy link shown only where the browser supports them; WhatsApp,
  Facebook, X, Telegram, LinkedIn, Pinterest, e-mail), `utm`.
- **Hosted page** — for items without a page of their own: `route_pattern` (`/p/{slug}`) fills the JSON source URL;
  renders heading, primary image, description, attributes and `slots` for the other elements; sets the document
  title (`hosted_page.title` string), description, canonical (`canonical_url` template, default the page URL) and
  robots. It then asks the Loader to place the other elements (`SS.refresh()`).

All copy is in the string catalogs (`strings/<lang>.json`, sliced per element by `stringKeys` and the website language), all colours, fonts, radii and spacing come from the
website's design tokens (`--ss-color-*`, `--ss-space-*`, …).

## 4. Your own UI (Mode B)

```js
import { createPriceBlock } from '@ss/product-pdp/headless/priceBlock.js';

const price = createPriceBlock({ config, strings });
price.subscribe((state) => paint(state.view)); // { price, compareAt, saving, percent, availability }
await price.actions.setItem(myItem); // or actions.load({ read: () => myItem, fetchJson, context: { locale } })
await price.actions.setVariant({ price: '39.00', availability: 'InStock' });
```

Every element follows the same shape: `state()` (frozen), `actions` (async, return `{ ok, value }` or
`{ ok: false, error: { code } }`), `subscribe`, `validate`, `strings`, `destroy`. The embeds take the Loader's API:
`actions.connect(window.SS.elements && { list: SS.elements.list, get: SS.elements.get, on: SS.on })`.
