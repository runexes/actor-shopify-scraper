# Shopify Scraper (Storefront GraphQL)

An Apify Actor that discovers Shopify product URLs from `sitemap.xml` and fetches product data through Shopify's Storefront GraphQL API.

The Actor is designed around **batched GraphQL requests**, not HTML product-page scraping. It can use a supplied public Storefront token, tokenless Storefront access where supported, or automatically discover a public Storefront token from the storefront's client-side HTML/JavaScript.

## Features

- Reads `sitemap.xml` and filters Shopify product URLs.
- Uses Storefront GraphQL as the primary product data source.
- Batches product handles into GraphQL requests using aliases.
- Supports tokenless Storefront product access where available.
- Automatically discovers and validates a public Storefront API token when tokenless access is unavailable.
- Caches discovered public tokens in Apify Key-Value Store per shop.
- Invalidates and rediscoveres a cached token after authentication failures.
- Handles partial GraphQL errors without discarding successful products.
- Retries failed products and transient batches with bounded retries.
- Uses the currency returned by Shopify for each variant.
- Supports incremental processing and last-modified filtering.
- Buffers Dataset writes for better throughput.
- Preserves `extendScraperFunction` and `extendOutputFunction`.

## Basic input

For the normal case, only a sitemap is needed:

```json
{
    "startUrls": [{ "url": "https://example.com/sitemap.xml" }]
}
```

The Actor derives the storefront origin from the sitemap/product URLs.

Authentication is resolved in this order:

1. `storefrontAccessToken`, when explicitly supplied.
2. A previously discovered public token cached in Apify Key-Value Store.
3. Tokenless Storefront GraphQL access.
4. Public token discovery from the storefront homepage and a limited number of same-origin JavaScript assets.
5. Validation of every candidate with a real Storefront GraphQL `products` query.

If no valid authentication path is available, the Actor reports that a public Storefront token could not be discovered and suggests supplying one manually.

## Shopify Storefront API

The default Storefront API version is `2026-07`.

Advanced inputs:

- `storefrontApiVersion` — override the API version if required.
- `storefrontShopDomain` — override the GraphQL API origin.
- `storefrontAccessToken` — optional public Storefront API token. It is not required for the normal automatic-discovery flow.

Discovered tokens are stored as operational state in the Apify Key-Value Store. They are **never written to the output Dataset**.

## Performance inputs

- `maxRequestsPerCrawl` — maximum number of product URLs; `0` means unlimited.
- `maxConcurrency` — sitemap/product discovery concurrency.
- `maxRequestRetries` — Crawlee retries.
- `updatedSince` — skip products whose sitemap `<lastmod>` is older than this date.
- `batchSize` — product handles per GraphQL request.
- `flushIntervalMs` — maximum wait before sending a partial batch.
- `perHostConcurrency` — parallel GraphQL requests per store.
- `bufferWrites` — buffer Dataset writes.
- `bufferSize` — number of items to buffer before pushing.

## Token discovery

Discovery intentionally searches only for **public Storefront credentials exposed to storefront clients**.

The flow is:

```text
sitemap
  ↓
store origin
  ↓
cached token?
  ↓ no
tokenless GraphQL?
  ↓ no
homepage HTML
  ↓
same-origin JS assets
  ↓
candidate tokens
  ↓
GraphQL validation
  ↓
cache valid public token
```

The Actor does not attempt to obtain private Shopify credentials.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Create local storage:

```bash
make init
```

3. Edit:

```text
apify_storage/key_value_stores/default/INPUT.json
```

A token is optional:

```json
{
    "startUrls": [{ "url": "https://example.com/sitemap.xml" }],
    "maxRequestsPerCrawl": 50,
    "debugLog": true
}
```

4. Run:

```bash
npm start
```

Development mode:

```bash
npm run dev
```

Tests:

```bash
npm test
```

Lint:

```bash
npm run lint
```

## Docker

```bash
make build
make run
```

The Actor uses Apify's Node.js 24 slim base image and installs its runtime dependencies from `package-lock.json`.

## Output

One Dataset item is produced per product. The output includes the product URL, title, SKU, price, currency, availability, images, brand and variant information.

## License

Apache-2.0
