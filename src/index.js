// @ts-nocheck
import { Actor, log } from 'apify';
import { BasicCrawler, createRequestDebugInfo } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as fns from './functions.js';


export const entry = async () => {
    /** @type {any} */
    const input = await Actor.getInput();

    const {
        startUrls = [],
        maxConcurrency = 20,
        maxRequestsPerCrawl,
        maxRequestRetries = 3,
        proxyConfig,
        debugLog = false,
        storefrontApiVersion = '2024-07',
        storefrontAccessToken = '',
        storefrontShopDomain = '',
        updatedSince = '',
        batchSize = 10,
        flushIntervalMs = 300,
        perHostConcurrency = 2,
        bufferWrites = true,
        bufferSize = 100,
    } = input;

    if (debugLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    const proxyConfiguration = await fns.createProxyConfigurationChecked({
        proxyConfig,
    });

    if (!startUrls?.length) {
        throw new Error('Missing "startUrls" input');
    }

    /**
     * Collect sitemap URLs directly from provided startUrls
     * @type {Set<string>}
     */
    const filteredSitemapUrls = new Set();

    for await (const { url } of fns.iterateStartUrls(startUrls)) {
        filteredSitemapUrls.add(url);
    }

    const mapToDataset = async ({ product, url, images, imagesWithoutVariants }) => {
            if (!product) {
                return;
            }

            // dates and product_type are intentionally omitted from output

            const allVariants = Array.isArray(product.variants) ? product.variants : [];
            const primaryVariant = allVariants[0] || {};

            const { name, props } = fns.deriveVariantAttributes(primaryVariant, product);
            const description = fns.pickFirstAvailable([product], ['body_html', 'descriptionHtml', 'description']);
            const stock_count = fns.pickFirstAvailable([primaryVariant], ['inventoryQuantity', 'inventory_quantity']);
            const availableForSale = fns.pickFirstAvailable([primaryVariant], ['availableForSale', 'available_for_sale']);
            const weight_unit = fns.pickFirstAvailable([primaryVariant], ['weight_unit', 'weightUnit']);
            const display_name = fns.pickFirstAvailable([primaryVariant], ['displayName', 'display_name']);

            return {
                url,
                color: props.color ?? null,
                size: props.size ?? null,
                material: props.material ?? null,
                display_name: display_name ?? null,
                title: product.title,
                id: `${fns.stripShopifyGid(product.id)}`,
                description: (description && fns.stripHtml(description)?.result) || null,
                sku: `${primaryVariant.sku || (primaryVariant.id ? fns.stripShopifyGid(primaryVariant.id) : '')}`,
                availability: +stock_count
                    ? (stock_count > 0 ? 'in stock' : 'out of stock')
                    : availableForSale ? 'in stock' : 'out of stock',
                price: +primaryVariant.price || null,
                currency: 'USD',
                images_urls: fns.uniqueDefinedArray([
                    primaryVariant.image_id ? images.get(primaryVariant.image_id)?.src : undefined,
                    imagesWithoutVariants,
                    product.image?.src,
                ].flat().filter((s) => s).map(fns.stripUrlQuery)),
                brand: product.vendor,
                video_urls: [],
                additional: {
                    variant_attributes: name,
                    variant_title: primaryVariant.title ?? null,
                    scraped_at: new Date(),
                    barcode: primaryVariant.barcode || null,
                    taxcode: primaryVariant.taxcode || null,
                    tags: fns.uniqueDefinedArray(Array.isArray(product.tags) ? product.tags : (product.tags ?? '').split(/,\s*/g)),
                    weight: primaryVariant.weight ? `${primaryVariant.weight} ${weight_unit}` : null,
                    variants: allVariants.map((v) => ({
                        id: v.id,
                        sku: v.sku,
                        title: v.title,
                        price: v.price ?? null,
                        image_id: v.image_id ?? null,
                    })),
                    ...Object.entries(props)
                        .filter(([prop]) => ![
                            'color',
                            'size',
                            'material',
                            'created_at',
                            'updated_at',
                            'published_at',
                        ].includes(prop))
                        .reduce((out, [prop, value]) => ({ ...out, [prop]: value }), {}),
                },
            };
    };

    const extendScraperFunction = await fns.compileExtendFunction({
        key: 'extendScraperFunction',
        input,
        helpers: {
            fns,
        },
    });

    // Incremental processing: skip previously seen product IDs
    const processedKey = 'PROCESSED_IDS';
    /** @type {Record<string, true>} */
    const processed = (await Actor.getValue(processedKey)) || {};

    // Dataset buffering
    const itemsBuffer = [];
    const flushItems = async () => {
        if (!itemsBuffer.length) return;
        const toPush = itemsBuffer.splice(0, itemsBuffer.length);
        await Actor.pushData(toPush);
    };

    // Recreate extendOutputFunction to use buffered output
    const bufferedOutputFunction = async (data) => {
        if (!data) return;
        if (bufferWrites) {
            itemsBuffer.push(data);
            if (itemsBuffer.length >= bufferSize) await flushItems();
        } else {
            await Actor.pushData(data);
        }
    };
    // Replace output sink with buffered version
    // Note: recompile to capture buffered output
    const extendOutputFunctionBuffered = await fns.compileExtendFunction({
        key: 'extendOutputFunction',
        map: async (data, ctx) => mapToDataset(data, ctx),
        output: bufferedOutputFunction,
        input,
        helpers: { fns },
    });
    // Use the buffered version going forward
    const runExtendOutput = extendOutputFunctionBuffered;

    // Per-host batching state
    /** @type {Map<string, { pending: {handle:string,url:string}[], timer:any, active:number }>} */
    const hostState = new Map();

    const buildBatchQuery = (entries) => {
        const vars = {};
        const lines = entries.map((e, i) => {
            const vn = `h${i}`;
            vars[vn] = e.handle;
            return `p${i}: product(handle: $${vn}) {\n    id\n    title\n    descriptionHtml\n    vendor\n    productType\n    tags\n    featuredImage { id url }\n    images(first: 100) { edges { node { id url } } }\n    options { name values }\n    createdAt\n    updatedAt\n    publishedAt\n    variants(first: 100) { edges { node { id title sku availableForSale requiresShipping weight weightUnit barcode image { id url } price { amount currencyCode } selectedOptions { name value } } } }\n  }`;
        }).join('\n');
        return { query: `query(${entries.map((_, i) => `$h${i}: String!`).join(', ')}) {\n${lines}\n}`, variables: vars };
    };

    const sendBatch = async (origin) => {
        const state = hostState.get(origin);
        if (!state) return;
        if (!state.pending.length) return;
        if (state.active >= perHostConcurrency) return;
        const entries = state.pending.splice(0, Math.min(batchSize, state.pending.length));
        state.active++;

        try {
            const apiOrigin = storefrontShopDomain?.trim() ? storefrontShopDomain.trim().replace(/\/$/, '') : origin;
            const endpoint = `${apiOrigin}/api/${storefrontApiVersion}/graphql.json`;
            const { query, variables } = buildBatchQuery(entries);

            log.debug(`Sending batch to ${endpoint}`);
            log.debug(`Query: ${query}`);
            log.debug(`Variables: ${JSON.stringify(variables)}`);

            const response = await gotScraping({
                url: endpoint,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-shopify-storefront-access-token': storefrontAccessToken,
                },
                json: { query, variables },
                retry: { limit: 1 },
            });
            log.debug(`Response: ${response.body}`);
            log.debug("--------------------------------\n");

            if (response.statusCode !== 200) throw new Error(`GraphQL status ${response.statusCode}`);
            const { data, errors } = JSON.parse(response.body);
            if (errors?.length) throw new Error(`GraphQL batch error: ${errors[0]?.message || 'Unknown'}`);

            for (let i = 0; i < entries.length; i++) {
                const alias = `p${i}`;
                const gqlProduct = data?.[alias];
                if (!gqlProduct?.title) continue;

                const product = (() => {
                    const imagesArr = [ ...(gqlProduct.images?.edges || []).map((e) => ({ id: e.node.id, src: e.node.url })) ];
                    if (gqlProduct.featuredImage) imagesArr.push({ id: gqlProduct.featuredImage.id, src: gqlProduct.featuredImage.url });
                    const options = (gqlProduct.options || []).map((o) => ({ name: o.name, values: o.values }));
                    const variants = (gqlProduct.variants?.edges || []).map((e) => {
                        const node = e.node; const optionProps = {}; node.selectedOptions?.forEach((opt, idx) => { optionProps[`option${idx + 1}`] = opt.value; });
                        return { id: node.id, title: node.title, sku: node.sku, availableForSale: node.availableForSale, requires_shipping: node.requiresShipping ?? null, weight: node.weight ?? null, weight_unit: node.weightUnit ?? null, barcode: node.barcode ?? null, price: node.price?.amount ?? null, currencyCode: node.price?.currencyCode ?? null, image_id: node.image?.id ?? null, ...optionProps };
                    });
                    return { id: gqlProduct.id, title: gqlProduct.title, descriptionHtml: gqlProduct.descriptionHtml, vendor: gqlProduct.vendor, productType: gqlProduct.productType, tags: gqlProduct.tags, image: gqlProduct.featuredImage ? { id: gqlProduct.featuredImage.id, src: gqlProduct.featuredImage.url } : undefined, images: imagesArr, options, variants, createdAt: gqlProduct.createdAt, updatedAt: gqlProduct.updatedAt, publishedAt: gqlProduct.publishedAt };
                })();

                const url = entries[i].url;
                const variants = fns.mapEntitiesById(product.variants);
                const images = fns.mapEntitiesById([...(product.images || []), product.image]);
                const imagesWithoutVariants = (product.images ?? []).map(({ src }) => src).filter(Boolean);

                const productId = `${fns.stripShopifyGid(product.id)}`;
                if (processed[productId]) continue;

                await runExtendOutput({ product, variants, url, images, imagesWithoutVariants }, {});
                processed[productId] = true;
            }
        } catch (e) {
            log.exception(e, 'Batch request failed', { origin });
        } finally {
            state.active--;
            log.debug(`Batch sent to ${origin}, active: ${state.active}`);
            if (state.pending.length) void sendBatch(origin);
        }
    };

    const queueHandle = (origin, handle, url) => {
        let state = hostState.get(origin);
        if (!state) {
            state = { pending: [], timer: null, active: 0 };
            hostState.set(origin, state);
        }
        state.pending.push({ handle, url });
        if (state.pending.length >= batchSize && state.active < perHostConcurrency) {
            void sendBatch(origin);
        } else if (!state.timer) {
            state.timer = setTimeout(() => {
                state.timer = null;
                if (state.pending.length && state.active < perHostConcurrency) void sendBatch(origin);
            }, flushIntervalMs);
        }
    };

    const requestQueue = await Actor.openRequestQueue();

    await extendScraperFunction(undefined, {
        proxyConfiguration,
        filteredSitemapUrls,
        requestQueue,
        label: 'SETUP',
    });

    const requestList = await fns.buildRequestListFromSitemaps({
        proxyConfiguration,
        requestQueue,
        maxConcurrency,
        limit: +maxRequestsPerCrawl,
        filter: async (url, lastmod, isSitemap) => {
            const isProduct = /\/products\//.test(url);
            const isProductSitemap = /sitemap_products_\d+/.test(url);

            if (isSitemap) {
                // Only include product sitemap files
                return isProductSitemap;
            }

            if (!isProduct) {
                return false;
            }

            if (updatedSince && lastmod) {
                const since = new Date(updatedSince);
                const lm = new Date(lastmod);
                if (Number.isFinite(+since) && Number.isFinite(+lm)) {
                    if (lm < since) return false;
                }
            }

            /** @type {boolean} */
            let filtered = isProduct;

            /** @param {boolean} result */
            const filter = (result) => {
                filtered = filtered && result;
            };

            await extendScraperFunction(undefined, {
                url,
                filter,
                isSitemap,
                isProduct,
                label: 'FILTER_SITEMAP_URL',
            });

            return filtered;
        },
        map: (url) => ({ url, userData: { url, label: 'PRODUCT' } }),
        sitemapUrls: [...filteredSitemapUrls.values()],
    });

    await Actor.setValue('STATS', { count: requestList.length() });

    const crawler = new BasicCrawler({
        requestList,
        requestQueue,
        useSessionPool: true,
        maxConcurrency,
        requestHandlerTimeoutSecs: 60,
        sessionPoolOptions: { sessionOptions: { maxErrorScore: 0.5 } },
        maxRequestRetries,
        maxRequestsPerCrawl: +maxRequestsPerCrawl > 0
            ? (+maxRequestsPerCrawl) + await requestQueue.handledCount() // reusing the same request queue
            : undefined,
        requestHandler: async ({ request }) => {
            if (!storefrontAccessToken) throw new Error('Missing storefrontAccessToken');
            const pageUrl = new URL(request.url);
            const origin = pageUrl.origin;
            const handleMatch = pageUrl.pathname.match(/\/products\/([^/?#]+)/);
            if (!handleMatch) throw new Error('Cannot derive product handle from URL');
            const handle = decodeURIComponent(handleMatch[1]);
            queueHandle(origin, handle, request.url);
        },
        failedRequestHandler: async ({ request, error }) => {
            log.exception(error, 'Failed all retries', { url: request.url });

            await Actor.pushData({
                '#failed': createRequestDebugInfo(request),
            });
        },
    });

    await extendScraperFunction(undefined, {
        crawler,
        requestList,
        label: 'RUN',
    });

    if (!debugLog) { fns.patchCrawlerLog(crawler); }

    await crawler.run();

    await extendScraperFunction(undefined, {
        crawler,
        label: 'FINISHED',
    });

    // Final flush and persist incremental state
    await flushItems();
    await Actor.setValue(processedKey, processed);
};
