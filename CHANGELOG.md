## 2026-09-16

### 0.2.0
- Added automatic public Storefront token discovery from storefront HTML and same-origin JavaScript assets.
- Added tokenless Storefront GraphQL probing before token discovery.
- Added per-shop cached token state in Apify Key-Value Store with invalidation on authentication failure.
- Made `storefrontAccessToken` optional; `startUrls` is now the only required input.
- Updated the default Storefront API version to 2026-07.
- Fixed product currency to use the variant currency returned by Shopify instead of hardcoded USD.
- Added partial GraphQL error handling and bounded batch retries.
- Fixed final batch draining so queued GraphQL work finishes before the Actor exits.
- Scoped incremental product state by shop domain.
- Fixed sitemap URL de-duplication and preserved Shopify GIDs as strings to avoid numeric precision loss.
- Updated the Docker base image to Node.js 24 slim.

## 2025-08-15

Initial
