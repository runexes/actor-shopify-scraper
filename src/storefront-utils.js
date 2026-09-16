export const normalizeOrigin = (value) => {
    const url = new URL(value);
    return url.origin;
};

export const normalizeShopDomain = (value) => {
    const hostname = new URL(
        value.includes("://") ? value : `https://${value}`,
    ).hostname.toLowerCase();
    return hostname.replace(/^www\./, "");
};

const TOKEN_PATTERNS = [
    /(?:publicStorefrontToken|storefrontAccessToken|publicAccessToken)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi,
    /(?:X-Shopify-Storefront-Access-Token|x-shopify-storefront-access-token)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi,
    /(?:storefrontApiAccessToken|storefrontApiToken)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi,
];

export const extractTokenCandidates = (text) => {
    const candidates = new Set();

    for (const pattern of TOKEN_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const token = `${match[1] || ""}`.trim();
            if (token && token.length >= 8 && token.length <= 512) {
                candidates.add(token);
            }
        }
    }

    return [...candidates];
};
