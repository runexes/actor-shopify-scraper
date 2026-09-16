import test from "node:test";
import assert from "node:assert/strict";
import {
    extractTokenCandidates,
    normalizeOrigin,
    normalizeShopDomain,
} from "../src/storefront-utils.js";

test("normalizes storefront origins", () => {
    assert.equal(
        normalizeOrigin("https://www.example.com/path"),
        "https://www.example.com",
    );
});

test("normalizes shop domains for cache keys", () => {
    assert.equal(
        normalizeShopDomain("https://WWW.Example.com/path"),
        "example.com",
    );
    assert.equal(
        normalizeShopDomain("example.myshopify.com"),
        "example.myshopify.com",
    );
});

test("extracts public Storefront token candidates from common frontend patterns", () => {
    const source = `
		const config = {
			publicAccessToken: "token-one",
			storefrontAccessToken: 'token-two'
		};
		fetch('/graphql', {
			headers: { 'X-Shopify-Storefront-Access-Token': 'token-three' }
		});
	`;

    assert.deepEqual(extractTokenCandidates(source).sort(), [
        "token-one",
        "token-three",
        "token-two",
    ]);
});

test("deduplicates token candidates", () => {
    const source = `
		publicAccessToken: "same-token";
		publicAccessToken: "same-token";
	`;

    assert.deepEqual(extractTokenCandidates(source), ["same-token"]);
});
