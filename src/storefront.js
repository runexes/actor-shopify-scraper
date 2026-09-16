// @ts-nocheck
import { Actor, log } from "apify";
import { gotScraping } from "got-scraping";
import {
    extractTokenCandidates,
    normalizeOrigin,
    normalizeShopDomain,
} from "./storefront-utils.js";

export {
    extractTokenCandidates,
    normalizeOrigin,
    normalizeShopDomain,
} from "./storefront-utils.js";

export const DEFAULT_STOREFRONT_API_VERSION = "2026-07";
const CACHE_PREFIX = "SHOPIFY_STOREFRONT_AUTH_";
const DISCOVERY_MAX_SCRIPTS = 16;
const DISCOVERY_MAX_SCRIPT_BYTES = 2_000_000;
const REQUEST_TIMEOUT = {
    response: 15000,
    request: 20000,
};

const cacheKey = (shopDomain) =>
    `${CACHE_PREFIX}${Buffer.from(shopDomain).toString("base64url")}`;

const requestGraphQL = async ({
    apiOrigin,
    apiVersion,
    token,
    query,
    variables = {},
    proxyConfiguration,
}) => {
    const endpoint = `${apiOrigin}/api/${apiVersion}/graphql.json`;
    const headers = {
        "content-type": "application/json",
        accept: "application/json",
    };

    if (token) {
        headers["x-shopify-storefront-access-token"] = token;
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
        timeout: REQUEST_TIMEOUT,
    });

    let body = null;
    try {
        body = JSON.parse(response.body);
    } catch {
        body = null;
    }

    return {
        statusCode: response.statusCode,
        body,
        headers: response.headers,
    };
};

const TOKENLESS_PROBE_QUERY = `query {
	products(first: 1) {
		nodes {
			id
			title
		}
	}
}`;

export const validateStorefrontToken = async ({
    apiOrigin,
    apiVersion,
    token,
    proxyConfiguration,
}) => {
    const result = await requestGraphQL({
        apiOrigin,
        apiVersion,
        token,
        query: TOKENLESS_PROBE_QUERY,
        proxyConfiguration,
    });

    return (
        result.statusCode === 200 &&
        !result.body?.errors?.length &&
        Array.isArray(result.body?.data?.products?.nodes)
    );
};

export const probeTokenlessStorefront = async ({
    apiOrigin,
    apiVersion,
    proxyConfiguration,
}) => {
    const result = await requestGraphQL({
        apiOrigin,
        apiVersion,
        query: TOKENLESS_PROBE_QUERY,
        proxyConfiguration,
    });

    if (
        result.statusCode === 200 &&
        !result.body?.errors?.length &&
        Array.isArray(result.body?.data?.products?.nodes)
    ) {
        return true;
    }

    return false;
};

const extractScriptUrls = (html, origin) => {
    const urls = new Set();
    const pageOrigin = new URL(origin).origin;

    const scriptRegex = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;

    while (
        (match = scriptRegex.exec(html)) !== null &&
        urls.size < DISCOVERY_MAX_SCRIPTS
    ) {
        try {
            const url = new URL(match[1], origin);
            const host = url.hostname.toLowerCase();
            const allowedHost =
                url.origin === pageOrigin ||
                host === "cdn.shopify.com" ||
                host.endsWith(".shopifycdn.com");

            if (
                allowedHost &&
                /^https?:$/i.test(url.protocol) &&
                /\.(?:js|mjs)(?:$|\?)/i.test(url.pathname)
            ) {
                urls.add(url.href);
            }
        } catch {
            // Ignore malformed script URLs.
        }
    }

    return [...urls];
};

export const discoverStorefrontToken = async ({
    storefrontOrigin,
    apiOrigin,
    apiVersion,
    proxyConfiguration,
}) => {
    const homepageResponse = await gotScraping({
        url: storefrontOrigin,
        proxyUrl: proxyConfiguration
            ? await proxyConfiguration.newUrl()
            : undefined,
        timeout: REQUEST_TIMEOUT,
        throwHttpErrors: false,
        retry: { limit: 1 },
    });

    if (homepageResponse.statusCode !== 200) {
        throw new Error(
            `Storefront homepage returned HTTP ${homepageResponse.statusCode}`,
        );
    }

    const html = homepageResponse.body || "";
    const texts = [html];
    const scriptUrls = extractScriptUrls(html, storefrontOrigin);

    log.debug(
        `Storefront token discovery: found ${scriptUrls.length} same-origin JS assets`,
    );

    for (const scriptUrl of scriptUrls) {
        if (extractTokenCandidates(texts.join("\n")).length > 0) break;

        try {
            const response = await gotScraping({
                url: scriptUrl,
                proxyUrl: proxyConfiguration
                    ? await proxyConfiguration.newUrl()
                    : undefined,
                timeout: REQUEST_TIMEOUT,
                throwHttpErrors: false,
                retry: { limit: 1 },
                headers: {
                    accept: "application/javascript,text/javascript,*/*;q=0.1",
                },
            });

            if (
                response.statusCode === 200 &&
                Buffer.byteLength(response.body || "", "utf8") <=
                    DISCOVERY_MAX_SCRIPT_BYTES
            ) {
                texts.push(response.body);
            }
        } catch (error) {
            log.debug(`Storefront token discovery: failed to fetch JS asset`, {
                url: scriptUrl,
                error: error.message,
            });
        }
    }

    const candidates = extractTokenCandidates(texts.join("\n"));
    log.info(
        `Storefront token discovery: ${candidates.length} candidate(s) found`,
    );

    for (let i = 0; i < candidates.length; i++) {
        const token = candidates[i];
        log.debug(
            `Storefront token discovery: validating candidate ${i + 1}/${candidates.length}`,
        );

        if (
            await validateStorefrontToken({
                apiOrigin,
                apiVersion,
                token,
                proxyConfiguration,
            })
        ) {
            return token;
        }
    }

    return null;
};

export class StorefrontAuthManager {
    constructor({
        apiVersion = DEFAULT_STOREFRONT_API_VERSION,
        explicitToken = "",
        storefrontShopDomain = "",
        proxyConfiguration,
    }) {
        this.apiVersion = apiVersion || DEFAULT_STOREFRONT_API_VERSION;
        this.explicitToken = explicitToken?.trim() || "";
        this.storefrontShopDomain = storefrontShopDomain?.trim() || "";
        this.proxyConfiguration = proxyConfiguration;
        this.authByOrigin = new Map();
        this.refreshingByOrigin = new Map();
    }

    getApiOrigin(origin) {
        return this.storefrontShopDomain
            ? normalizeOrigin(this.storefrontShopDomain)
            : origin;
    }

    async loadCachedToken(apiOrigin) {
        const domain = normalizeShopDomain(apiOrigin);
        const cached = await Actor.getValue(cacheKey(domain));

        if (!cached?.token) return null;

        if (cached.apiVersion && cached.apiVersion !== this.apiVersion) {
            log.debug(
                `Ignoring cached Storefront token from API version ${cached.apiVersion}`,
            );
            return null;
        }

        return cached.token;
    }

    async saveCachedToken(apiOrigin, token) {
        const domain = normalizeShopDomain(apiOrigin);
        await Actor.setValue(cacheKey(domain), {
            token,
            apiVersion: this.apiVersion,
            discoveredAt: new Date().toISOString(),
        });
    }

    async invalidateCachedToken(apiOrigin) {
        await Actor.setValue(cacheKey(normalizeShopDomain(apiOrigin)), null);
    }

    async discoverPublicToken(origin) {
        const apiOrigin = this.getApiOrigin(origin);
        const token = await discoverStorefrontToken({
            storefrontOrigin: origin,
            apiOrigin,
            apiVersion: this.apiVersion,
            proxyConfiguration: this.proxyConfiguration,
        });

        if (!token) {
            throw new Error(
                `Unable to discover a public Storefront API token for ${origin}. Provide storefrontAccessToken manually.`,
            );
        }

        await this.saveCachedToken(apiOrigin, token);

        const auth = { token, source: "discovered", apiOrigin };
        this.authByOrigin.set(origin, auth);
        log.info(
            `Public Storefront token discovered and cached for ${normalizeShopDomain(apiOrigin)}`,
        );
        return auth;
    }

    async resolve(origin) {
        if (this.authByOrigin.has(origin)) return this.authByOrigin.get(origin);

        const promise = this.resolveFresh(origin);
        this.refreshingByOrigin.set(origin, promise);

        try {
            const auth = await promise;
            this.authByOrigin.set(origin, auth);
            return auth;
        } finally {
            this.refreshingByOrigin.delete(origin);
        }
    }

    async resolveFresh(origin) {
        const apiOrigin = this.getApiOrigin(origin);

        if (this.explicitToken) {
            return { token: this.explicitToken, source: "input", apiOrigin };
        }

        const cachedToken = await this.loadCachedToken(apiOrigin);
        if (
            cachedToken &&
            (await validateStorefrontToken({
                apiOrigin,
                apiVersion: this.apiVersion,
                token: cachedToken,
            }))
        ) {
            log.info(
                `Using cached public Storefront token for ${normalizeShopDomain(apiOrigin)}`,
            );
            return { token: cachedToken, source: "cache", apiOrigin };
        }

        if (cachedToken) {
            log.info(
                `Cached public Storefront token is no longer valid; rediscovering`,
            );
            await this.invalidateCachedToken(apiOrigin);
        }

        if (
            await probeTokenlessStorefront({
                apiOrigin,
                apiVersion: this.apiVersion,
                proxyConfiguration: this.proxyConfiguration,
            })
        ) {
            log.info(
                `Storefront API supports tokenless product access for ${normalizeShopDomain(apiOrigin)}`,
            );
            return { token: "", source: "tokenless", apiOrigin };
        }

        log.info(
            `Tokenless Storefront API unavailable; discovering public token for ${normalizeShopDomain(apiOrigin)}`,
        );
        return this.discoverPublicToken(origin);
    }

    async refresh(origin) {
        const apiOrigin = this.getApiOrigin(origin);

        if (this.explicitToken) {
            return this.resolve(origin);
        }

        const current = this.authByOrigin.get(origin);
        this.authByOrigin.delete(origin);
        await this.invalidateCachedToken(apiOrigin);

        // If tokenless access was selected but the real product query is
        // rejected (for example because its complexity exceeds the tokenless
        // limit), skip the tokenless probe and go straight to public-token
        // discovery.
        if (current?.source === "tokenless") {
            return this.discoverPublicToken(origin);
        }

        return this.resolve(origin);
    }
}
