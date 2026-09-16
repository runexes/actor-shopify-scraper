// @ts-nocheck
import { Actor, log } from "apify";
import { BasicCrawler, createRequestDebugInfo } from "crawlee";
import { gotScraping } from "got-scraping";
import * as fns from "./functions.js";
import {
    DEFAULT_STOREFRONT_API_VERSION,
    StorefrontAuthManager,
} from "./storefront.js";

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
        storefrontApiVersion = DEFAULT_STOREFRONT_API_VERSION,
        storefrontAccessToken = "",
        storefrontShopDomain = "",
        updatedSince = "",
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

    const mapToDataset = async ({
        product,
        url,
        images,
        imagesWithoutVariants,
    }) => {
        if (!product) {
            return;
        }

        // dates and product_type are intentionally omitted from output

        const allVariants = Array.isArray(product.variants)
            ? product.variants
            : [];
        const primaryVariant = allVariants[0] || {};

        const { name, props } = fns.deriveVariantAttributes(
            primaryVariant,
            product,
        );
        const description = fns.pickFirstAvailable(
            [product],
            ["body_html", "descriptionHtml", "description"],
        );
        const stock_count = fns.pickFirstAvailable(
            [primaryVariant],
            ["inventoryQuantity", "inventory_quantity"],
        );
        const availableForSale = fns.pickFirstAvailable(
            [primaryVariant],
            ["availableForSale", "available_for_sale"],
        );
        const weight_unit = fns.pickFirstAvailable(
            [primaryVariant],
            ["weight_unit", "weightUnit"],
        );
        const display_name = fns.pickFirstAvailable(
            [primaryVariant],
            ["displayName", "display_name"],
        );

        return {
            url,
            color: props.color ?? null,
            size: props.size ?? null,
            material: props.material ?? null,
            display_name: display_name ?? null,
            title: product.title,
            id: `${fns.stripShopifyGid(product.id)}`,
            description:
                (description && fns.stripHtml(description)?.result) || null,
            sku: `${primaryVariant.sku || (primaryVariant.id ? fns.stripShopifyGid(primaryVariant.id) : "")}`,
            availability: +stock_count
                ? stock_count > 0
                    ? "in stock"
                    : "out of stock"
                : availableForSale
                  ? "in stock"
                  : "out of stock",
            price: +primaryVariant.price || null,
            currency: primaryVariant.currencyCode || null,
            images_urls: fns.uniqueDefinedArray(
                [
                    primaryVariant.image_id
                        ? images.get(primaryVariant.image_id)?.src
                        : undefined,
                    imagesWithoutVariants,
                    product.image?.src,
                ]
                    .flat()
                    .filter((s) => s)
                    .map(fns.stripUrlQuery),
            ),
            brand: product.vendor,
            video_urls: [],
            additional: {
                variant_attributes: name,
                variant_title: primaryVariant.title ?? null,
                scraped_at: new Date(),
                barcode: primaryVariant.barcode || null,
                taxcode: primaryVariant.taxcode || null,
                tags: fns.uniqueDefinedArray(
                    Array.isArray(product.tags)
                        ? product.tags
                        : (product.tags ?? "").split(/,\s*/g),
                ),
                weight: primaryVariant.weight
                    ? `${primaryVariant.weight} ${weight_unit}`
                    : null,
                variants: allVariants.map((v) => ({
                    id: v.id,
                    sku: v.sku,
                    title: v.title,
                    price: v.price ?? null,
                    image_id: v.image_id ?? null,
                })),
                ...Object.entries(props)
                    .filter(
                        ([prop]) =>
                            ![
                                "color",
                                "size",
                                "material",
                                "created_at",
                                "updated_at",
                                "published_at",
                            ].includes(prop),
                    )
                    .reduce(
                        (out, [prop, value]) => ({ ...out, [prop]: value }),
                        {},
                    ),
            },
        };
    };

    const extendScraperFunction = await fns.compileExtendFunction({
        key: "extendScraperFunction",
        input,
        helpers: {
            fns,
        },
    });

    // Incremental processing: skip previously seen product IDs
    const processedKey = "PROCESSED_IDS_V2";
    /** @type {Record<string, true>} */
    const processed = (await Actor.getValue(processedKey)) || {};

    const storefrontAuth = new StorefrontAuthManager({
        apiVersion: storefrontApiVersion,
        explicitToken: storefrontAccessToken,
        storefrontShopDomain,
        proxyConfiguration,
    });

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
        key: "extendOutputFunction",
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
        const lines = entries
            .map((e, i) => {
                const vn = `h${i}`;
                vars[vn] = e.handle;
                return `p${i}: product(handle: $${vn}) {\n    id\n    title\n    descriptionHtml\n    vendor\n    productType\n    tags\n    featuredImage { id url }\n    images(first: 100) { edges { node { id url } } }\n    options { name values }\n    createdAt\n    updatedAt\n    publishedAt\n    variants(first: 100) { edges { node { id title sku availableForSale requiresShipping weight weightUnit barcode image { id url } price { amount currencyCode } selectedOptions { name value } } } }\n  }`;
            })
            .join("\n");
        return {
            query: `query(${entries.map((_, i) => `$h${i}: String!`).join(", ")}) {\n${lines}\n}`,
            variables: vars,
        };
    };

    const sendBatch = async (origin) => {
        const state = hostState.get(origin);
        if (
            !state ||
            !state.pending.length ||
            state.active >= perHostConcurrency
        )
            return;

        const entries = state.pending.splice(
            0,
            Math.min(batchSize, state.pending.length),
        );
        state.active++;

        try {
            let auth = await storefrontAuth.resolve(origin);
            let retriedAfterAuthRefresh = false;
            let entriesToProcess = entries;

            while (entriesToProcess.length) {
                const apiOrigin = auth.apiOrigin;
                const endpoint = `${apiOrigin}/api/${storefrontApiVersion}/graphql.json`;
                const { query, variables } = buildBatchQuery(entriesToProcess);

                log.debug(`Sending batch to ${endpoint}`, {
                    origin,
                    authSource: auth.source,
                    entries: entriesToProcess.length,
                });

                const headers = {
                    "content-type": "application/json",
                    accept: "application/json",
                };

                if (auth.token) {
                    headers["x-shopify-storefront-access-token"] = auth.token;
                }

                const response = await gotScraping({
                    url: endpoint,
                    method: "POST",
                    proxyUrl: proxyConfiguration
                        ? await proxyConfiguration.newUrl()
                        : undefined,
                    headers,
                    json: { query, variables },
                    throwHttpErrors: false,
                    retry: { limit: 1 },
                    timeout: { response: 15000, request: 20000 },
                });

                log.debug(`GraphQL response`, {
                    statusCode: response.statusCode,
                });

                let body;
                try {
                    body = JSON.parse(response.body);
                } catch {
                    body = null;
                }

                if (
                    response.statusCode === 401 ||
                    response.statusCode === 403
                ) {
                    if (!retriedAfterAuthRefresh && !storefrontAccessToken) {
                        log.warning(
                            `Storefront authentication failed; invalidating cached token and rediscovering`,
                            { origin },
                        );
                        auth = await storefrontAuth.refresh(origin);
                        retriedAfterAuthRefresh = true;
                        continue;
                    }

                    throw new Error(
                        `GraphQL authentication failed with HTTP ${response.statusCode}`,
                    );
                }

                if (response.statusCode !== 200) {
                    throw new Error(`GraphQL HTTP ${response.statusCode}`);
                }

                if (!body) {
                    throw new Error(
                        "GraphQL returned an invalid JSON response",
                    );
                }

                const errors = Array.isArray(body.errors) ? body.errors : [];
                const failedAliases = new Set(
                    errors
                        .map((error) =>
                            Array.isArray(error.path)
                                ? error.path.find((part) =>
                                      /^p\d+$/.test(`${part}`),
                                  )
                                : null,
                        )
                        .filter(Boolean),
                );

                // Tokenless access has a lower query-complexity budget and some
                // fields require token-based access. If Shopify rejects the real
                // product query for an authentication/access reason, escalate once
                // to public-token discovery.
                const tokenlessAccessError = errors.some((error) =>
                    /token|access|complexity|unauthor|forbidden|scope/i.test(
                        `${error?.message || ""}`,
                    ),
                );

                if (
                    errors.length &&
                    auth.source === "tokenless" &&
                    tokenlessAccessError &&
                    !retriedAfterAuthRefresh &&
                    !storefrontAccessToken
                ) {
                    log.warning(
                        `Tokenless Storefront query was rejected; discovering a public token`,
                        { origin },
                    );
                    auth = await storefrontAuth.refresh(origin);
                    retriedAfterAuthRefresh = true;
                    continue;
                }

                // Shopify can return top-level GraphQL errors without an alias path.
                // If no usable product data came back, retry the whole batch instead
                // of silently losing every entry.
                const hasUsableProductData = entriesToProcess.some(
                    (_, index) => body.data?.[`p${index}`]?.title,
                );

                if (
                    errors.length &&
                    !hasUsableProductData &&
                    !failedAliases.size
                ) {
                    throw new Error(
                        `GraphQL batch error: ${errors[0]?.message || "Unknown"}`,
                    );
                }

                if (errors.length) {
                    log.warning(
                        `GraphQL returned ${errors.length} error(s) for a batch`,
                        {
                            origin,
                            errors: errors
                                .slice(0, 5)
                                .map((error) => error.message),
                        },
                    );
                }

                for (let i = 0; i < entriesToProcess.length; i++) {
                    const alias = `p${i}`;
                    if (failedAliases.has(alias)) continue;

                    const gqlProduct = body.data?.[alias];
                    if (!gqlProduct?.title) continue;

                    const product = (() => {
                        const imagesArr = [
                            ...(gqlProduct.images?.edges || []).map((e) => ({
                                id: e.node.id,
                                src: e.node.url,
                            })),
                        ];
                        if (gqlProduct.featuredImage) {
                            imagesArr.push({
                                id: gqlProduct.featuredImage.id,
                                src: gqlProduct.featuredImage.url,
                            });
                        }

                        const options = (gqlProduct.options || []).map((o) => ({
                            name: o.name,
                            values: o.values,
                        }));
                        const variants = (gqlProduct.variants?.edges || []).map(
                            (e) => {
                                const node = e.node;
                                const optionProps = {};
                                node.selectedOptions?.forEach((opt, idx) => {
                                    optionProps[`option${idx + 1}`] = opt.value;
                                });

                                return {
                                    id: node.id,
                                    title: node.title,
                                    sku: node.sku,
                                    availableForSale: node.availableForSale,
                                    requires_shipping:
                                        node.requiresShipping ?? null,
                                    weight: node.weight ?? null,
                                    weight_unit: node.weightUnit ?? null,
                                    barcode: node.barcode ?? null,
                                    price: node.price?.amount ?? null,
                                    currencyCode:
                                        node.price?.currencyCode ?? null,
                                    image_id: node.image?.id ?? null,
                                    ...optionProps,
                                };
                            },
                        );

                        return {
                            id: gqlProduct.id,
                            title: gqlProduct.title,
                            descriptionHtml: gqlProduct.descriptionHtml,
                            vendor: gqlProduct.vendor,
                            productType: gqlProduct.productType,
                            tags: gqlProduct.tags,
                            image: gqlProduct.featuredImage
                                ? {
                                      id: gqlProduct.featuredImage.id,
                                      src: gqlProduct.featuredImage.url,
                                  }
                                : undefined,
                            images: imagesArr,
                            options,
                            variants,
                            createdAt: gqlProduct.createdAt,
                            updatedAt: gqlProduct.updatedAt,
                            publishedAt: gqlProduct.publishedAt,
                        };
                    })();

                    const url = entriesToProcess[i].url;
                    const variants = fns.mapEntitiesById(product.variants);
                    const images = fns.mapEntitiesById([
                        ...(product.images || []),
                        product.image,
                    ]);
                    const imagesWithoutVariants = (product.images ?? [])
                        .map(({ src }) => src)
                        .filter(Boolean);

                    const productId = `${fns.stripShopifyGid(product.id)}`;
                    const processedKeyForProduct = `${fns.normalizeShopDomain(apiOrigin)}:${productId}`;

                    if (processed[processedKeyForProduct]) continue;

                    await runExtendOutput(
                        {
                            product,
                            variants,
                            url,
                            images,
                            imagesWithoutVariants,
                        },
                        {},
                    );

                    processed[processedKeyForProduct] = true;
                }

                const retryEntries = entriesToProcess
                    .filter((entry, index) => {
                        const alias = `p${index}`;
                        return (
                            failedAliases.has(alias) && (entry.attempt || 0) < 2
                        );
                    })
                    .map((entry) => ({
                        ...entry,
                        attempt: (entry.attempt || 0) + 1,
                    }));

                if (retryEntries.length) {
                    log.warning(
                        `Retrying ${retryEntries.length} product(s) with GraphQL errors`,
                        { origin },
                    );
                    entriesToProcess = retryEntries;
                    continue;
                }

                entriesToProcess = [];
            }
        } catch (e) {
            log.exception(e, "Batch request failed", { origin });

            // Requeue the whole batch a limited number of times. This prevents
            // transient GraphQL/HTTP failures from silently dropping products.
            const retryEntries = entries
                .filter((entry) => (entry.attempt || 0) < 2)
                .map((entry) => ({
                    ...entry,
                    attempt: (entry.attempt || 0) + 1,
                }));

            if (retryEntries.length) {
                state.pending.unshift(...retryEntries);
                log.warning(
                    `Requeued ${retryEntries.length} product(s) after batch failure`,
                    { origin },
                );
            } else {
                log.error(`Dropping batch after exhausting retries`, {
                    origin,
                    count: entries.length,
                });
            }
        } finally {
            state.active--;
            log.debug(`Batch sent to ${origin}, active: ${state.active}`);

            if (state.pending.length && state.active < perHostConcurrency) {
                void sendBatch(origin);
            }
        }
    };

    const queueHandle = (origin, handle, url) => {
        let state = hostState.get(origin);
        if (!state) {
            state = { pending: [], timer: null, active: 0 };
            hostState.set(origin, state);
        }
        state.pending.push({ handle, url });
        if (
            state.pending.length >= batchSize &&
            state.active < perHostConcurrency
        ) {
            void sendBatch(origin);
        } else if (!state.timer) {
            state.timer = setTimeout(() => {
                state.timer = null;
                if (state.pending.length && state.active < perHostConcurrency)
                    void sendBatch(origin);
            }, flushIntervalMs);
        }
    };

    const requestQueue = await Actor.openRequestQueue();

    await extendScraperFunction(undefined, {
        proxyConfiguration,
        filteredSitemapUrls,
        requestQueue,
        label: "SETUP",
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
                label: "FILTER_SITEMAP_URL",
            });

            return filtered;
        },
        map: (url) => ({ url, userData: { url, label: "PRODUCT" } }),
        sitemapUrls: [...filteredSitemapUrls.values()],
    });

    await Actor.setValue("STATS", { count: requestList.length() });

    const crawler = new BasicCrawler({
        requestList,
        requestQueue,
        useSessionPool: true,
        maxConcurrency,
        requestHandlerTimeoutSecs: 60,
        sessionPoolOptions: { sessionOptions: { maxErrorScore: 0.5 } },
        maxRequestRetries,
        maxRequestsPerCrawl:
            +maxRequestsPerCrawl > 0
                ? +maxRequestsPerCrawl + (await requestQueue.handledCount()) // reusing the same request queue
                : undefined,
        requestHandler: async ({ request }) => {
            const pageUrl = new URL(request.url);
            const origin = pageUrl.origin;
            const handleMatch = pageUrl.pathname.match(/\/products\/([^/?#]+)/);
            if (!handleMatch)
                throw new Error("Cannot derive product handle from URL");
            const handle = decodeURIComponent(handleMatch[1]);
            queueHandle(origin, handle, request.url);
        },
        failedRequestHandler: async ({ request, error }) => {
            log.exception(error, "Failed all retries", { url: request.url });

            await Actor.pushData({
                "#failed": createRequestDebugInfo(request),
            });
        },
    });

    await extendScraperFunction(undefined, {
        crawler,
        requestList,
        label: "RUN",
    });

    if (!debugLog) {
        fns.patchCrawlerLog(crawler);
    }

    await crawler.run();

    // The crawler only queues handles; wait until every GraphQL batch has
    // finished before flushing the Dataset and incremental state.
    const drainBatches = async () => {
        for (const [origin, state] of hostState.entries()) {
            if (state.timer) {
                clearTimeout(state.timer);
                state.timer = null;
            }
            if (state.pending.length && state.active < perHostConcurrency) {
                void sendBatch(origin);
            }
        }

        while (
            [...hostState.values()].some(
                (state) => state.pending.length || state.active > 0,
            )
        ) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            for (const [origin, state] of hostState.entries()) {
                if (state.pending.length && state.active < perHostConcurrency) {
                    void sendBatch(origin);
                }
            }
        }
    };

    await drainBatches();

    await extendScraperFunction(undefined, {
        crawler,
        label: "FINISHED",
    });

    // Final flush and persist incremental state
    await flushItems();
    await Actor.setValue(processedKey, processed);
};
