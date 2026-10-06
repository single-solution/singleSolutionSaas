# Reviews & Ratings — developer guide

## Three ways to use the widgets

- **Mode A (drop-in):** the Loader mounts `ui/reviews.js#render` with the website's design tokens (`stars`, `summary` or
  `list` variant; slots `before`, `after`, `empty`). Service-product elements also work through the Loader's element
  stub: `GET /v1/elements/display/view` returns a text-only view model (store-wide, or `?itemId=`).
- **Mode B (headless):** `headless/reviews.js#createReviews({ config, strings, client, emit })` with
  `createElementApi({ baseUrl, key: 'pk_…', identity })` from `@ss/web/element`. `actions.load(itemId)` loads the summary
  and the first page; `setSort`, `setFilter('rating' | 'verified' | 'photos', value)`, `loadMore`, `loadStars(itemIds)`
  for product lists; `openForm()` loads the form definition, `submit({ rating, title, body, attributes, author, token,
photoIds })` validates like the API and posts the review. Wrap it with `createUseElement(React)`.
- **Mode C (API):** see `openapi.json`. Browsers use the `pk_` key (public reads, submissions with `SS-Identity` or a
  review link `token`); your server uses the `sk_` key.

## Collecting verified reviews

1. Send `order.completed@1` to the Portal Event Hub with the customer (`customer.subject` = your login's subject,
   and/or `customer.customerId`, plus `customer.email` / `customer.phone` for requests) and the `lines`. If you do not
   use the Event Hub, call `POST /v1/review-requests` from your server.
2. With `request_flow` on and `collection.send_on_completion` on, the request is sent as soon as the order completes
   (there is no delayed send: the product runs no scheduled jobs). Reminders, retries and requests held by quiet
   hours go out with the website's next completed order, `POST /v1/request-flow:run` or **Send due requests now** in
   the dashboard. Requests go out through your messaging connector with a link built from `request_flow.review_url`
   (`https://shop.example.com/review?t={token}`); otherwise get a link with `POST /v1/review-requests/{id}/link` and send
   it yourself.
3. On the review page, `POST /v1/review-requests:open { token }` returns the order's items; submit each review with
   `POST /v1/reviews { token, itemId, rating, … }`. Signed-in customers can instead send their login token in
   `SS-Identity` and list what they can review with `GET /v1/review-requests`.

## Photos

`POST /v1/review-photos { contentType, size }` returns a presigned `PUT` to your bucket (send the returned headers; `content-type` and `content-length` are signed, so the body must be exactly `size` bytes).
Then submit the review with `photoIds`. The product checks the object (HEAD: exists, size, type) before attaching it.
Images are stored as uploaded — EXIF metadata is not stripped (see README, "Notes and limits").

## Moderation rules

Rules use rules@1 (`@ss/rules`). Context: `review` (`rating`, `scale`, `title`, `body`, `length`, `titleLength`,
`verified`, `photos`, `hasPhotos`, `attributes`, `source`, `locale`, `itemId`), `customer` (`id`, `identified`,
`reviewsToday`), `item` (`id`, `count`, `average`), `flags` (content-check codes) and `now` (website time zone).

```text
review.verified and len(flags) == 0                 # the default: approve clean verified reviews
review.rating <= 2 and review.length < 20           # queue short negative reviews for a person
customer.reviewsToday >= 5                          # queue bursts
```

Content checks run first: blocked terms (`moderation.blocked_terms`, your own list, whole words; scripts without word
separators match as substrings), links above `max_links`, text shorter than `queue_shorter_than`.

## Structured data

Fetch `GET /v1/structured-data/{itemId}` server-side (or from the browser with the `pk_` key) and embed it as
`<script type="application/ld+json">`. Pass `?name=` (and `url`, `image`, `sku`) when the item's title was never seen in
an order line. Ratings and reviews appear only from `structured_data.min_reviews` approved reviews.

## CSV import

`POST /v1/imports { csv, dryRun: true }` first; the report lists invalid rows (`row`, `path`, `code`). Columns are
mapped by `import.columns` (header names, case-insensitive); `external_id` makes re-imports idempotent.
