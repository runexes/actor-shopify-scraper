## Shopify Scraper (GraphQL)

An Apify actor that crawls Shopify stores via `sitemap.xml` and fetches product data using the Storefront GraphQL API. Optimized for speed and cost with per-host batching, incremental processing, and buffered dataset writes.

### Features
- Reads `sitemap.xml`, filters product URLs (`/products/<handle>`)
- Batches GraphQL requests per store using aliases (fewer round-trips)
- Optional incremental runs (skips already processed product IDs)
- Optional lastmod cutoff to skip old products
- Outputs a single record per product; all variants are available under `additional.variants`
- Extensible via `extendScraperFunction` and `extendOutputFunction`

### Input parameters (core)
- `startUrls`: array of `sitemap.xml` URLs
- `storefrontApiVersion`: Storefront API version (e.g., `2024-07`)
- `storefrontAccessToken`: your Storefront access token
- `maxRequestsPerCrawl`, `maxConcurrency`, `maxRequestRetries`, `proxyConfig`, `debugLog`
  
### Performance inputs
- `updatedSince`: ISO date; skips products with `<lastmod>` older than this
- `batchSize`: product handles per GraphQL request (default 10)
- `flushIntervalMs`: max delay before sending a partial batch (default 300)
- `perHostConcurrency`: parallel GraphQL requests per store (default 2)
- `bufferWrites`: buffer dataset writes (default true)
- `bufferSize`: items per dataset push (default 100)

### Run locally
1) Install dependencies:
```bash
npm install
```
2) Create local input at `apify_storage/key_value_stores/default/INPUT.json`, for example:
```json
{
  "startUrls": [{ "url": "https://example.com/sitemap.xml" }],
  "storefrontApiVersion": "2024-07",
  "storefrontAccessToken": "<YOUR_STOREFRONT_TOKEN>",
  "maxRequestsPerCrawl": 50,
  "maxConcurrency": 10,
  "debugLog": true
}
```
3) Start the actor:
```bash
npm start
```
Or development mode with auto-restart:
```bash
npm run dev
```

### GitHub integration
Workflows in `.github/workflows/`:
- `ci.yml`: install, lint, and syntax check on push/PR to `main`.
- `codeql.yml`: CodeQL security analysis on push/PR and weekly.

### Docker quick start
```bash
make init   # creates .env and INPUT.json from templates
make run    # docker compose up --build actor
```
Outputs will be in `apify_storage/datasets/default`.

### Extensibility
- `extendScraperFunction`: lifecycle hooks (`SETUP`, `FILTER_SITEMAP_URL`, `PRENAVIGATION`, `POSTNAVIGATION`, `RUN`, `FINISHED`)
- `extendOutputFunction`: transform/filter final records before they are saved to the Dataset

### License
This project is licensed under the Apache License 2.0. See `LICENSE` and `NOTICE`.
