// @ts-nocheck
import { Actor, log } from 'apify';
import { BasicCrawler, RequestList } from 'crawlee';
import { gotScraping } from 'got-scraping';
import { load } from 'cheerio';
import * as vm from 'vm';

export { stripHtml } from 'string-strip-html';


/**
 * Remove Shopify GID prefix from the string if present
 *
 * @param {string} str
 */
export const stripShopifyGid = (str) => {
	return +`${str}`.replace(/^gid:\/\/shopify\/[^/]+\//, '');
};

/**
 * Finds the first existing property among candidates across provided objects.
 *
 * @param {Array<Record<string, any>>} bases
 * @param {string[]} props
 */
export const pickFirstAvailable = (bases, props) => {
	for (const prop of props) {
		for (const base of bases) {
			if (prop in base) {
				return base[prop];
			}
		}
	}
};

/**
 * Convert the property name to a snake_case format for consistency
 *
 * @param {string} str
 */
export const toSnakeCase = (str) => {
	return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
};

/**
 * @param {string} date
 */
export const parseIsoDateSafe = (date) => {
	try {
		return new Date(date).toISOString();
	} catch {
		return null;
	}
};

/**
 *
 * @param {*} url
 */
// categorizeUrl removed (unused)

/**
 * Monkey-patch the handleRequestFunction failed... error
 *
 * @param {Apify.BasicCrawler} crawler
 */
export const patchCrawlerLog = (crawler) => {
	const originalException = crawler.log.exception.bind(crawler.log);
	crawler.log.exception = (...args) => {
		if (!args?.[1]?.includes('handleRequestFunction')) {
			originalException(...args);
		}
	};
};

/**
 * Transform a input.startUrls, parse requestsFromUrl items as well,
 * into regular urls. Returns an async generator that should be iterated over.
 *
 * @example
 *   for await (const req of fromStartUrls(input.startUrls)) {
 *     await requestQueue.addRequest(req);
 *   }
 *
 * @param {any[]} startUrls
 * @param {string} [name]
 */
export const iterateStartUrls = async function* (startUrls, name = 'INPUTURLS') {
	const rl = await RequestList.open(name, startUrls);

	/** @type {Apify.Request | null} */
	let rq;

	// eslint-disable-next-line no-cond-assign
	while (rq = await rl.fetchNextRequest()) {
		yield rq;
	}
};

/**
 * Uses a BasicCrawler to get links from sitemaps XMLs
 *
 * @example
 *   const proxyConfiguration = await Actor.createProxyConfiguration();
 *   const requestList = await requestListFromSitemaps({
 *
 *      sitemapUrls: [
 *         'https://example.com/sitemap.xml',
 *      ]
 *   })
 *
 * @param {{
 *  proxyConfiguration?: Apify.ProxyConfiguration,
 *  requestQueue: Apify.RequestQueue,
 *  sitemapUrls: string[],
 *  timeout?: number,
 *  limit?: number,
 *  maxConcurrency?: number
 *  filter: (url: string, lastmod?: string, isSitemap?: boolean) => Promise<boolean>,
 *  map: (url: string) => Apify.RequestOptions,
 * }} params
 */
export const buildRequestListFromSitemaps = async ({
	proxyConfiguration,
	filter,
	map,
	limit = 0,
	requestQueue,
	timeout = 300,
	sitemapUrls,
	maxConcurrency = 1,
}) => {
	const urls = new Set();

	/** @param {string} url */
	const cleanup = (url) => `${url}`.replace(/[\n\r]/g, '').trim();

	let count = 1;

	const sitemapCrawler = new BasicCrawler({
		requestList: await RequestList.open('SITEMAPS', sitemapUrls.map((u) => ({ url: u }))),
		requestQueue,
		useSessionPool: true,
		maxConcurrency,
		requestHandlerTimeoutSecs: timeout,
		sessionPoolOptions: {
			persistStateKey: 'SITEMAPS_SESSION_POOL',
			sessionOptions: {
				maxErrorScore: 0.5,
			},
		},
		maxRequestRetries: 5,
		requestHandler: async ({ request, session }) => {
			const response = await gotScraping({
				url: request.url,
				proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl(session?.id) : undefined,
				timeout: {
					response: 10000,
					request: 5000,
				},
				retry: { limit: 0 },
			});

			if (![200, 301, 302].includes(response.statusCode)) {
				throw new Error(`Status code ${response.statusCode}`);
			}

			log.debug(`Parsing sitemap ${request.url}`);

			const $ = load(response.body, { decodeEntities: true });

			const $locations = $('url loc');

			for (const el of $locations) {
				const url = cleanup($(el).text());
				const lastmod = cleanup($(el).parent().find('lastmod').text());

				if (await filter(url, lastmod, false)) {
					const limited = limit > 0
						? urls.size >= limit
						: false;

					if (!limited) {
						log.debug(`Adding product url`, { url });
						urls.add(map(url));
					} else {
						break;
					}
				}
			}

			// recursive sitemap
			for (const el of $('sitemap loc')) {
				const url = cleanup($(el).text());
				const lastmod = cleanup($(el).parent().find('lastmod').text());

				if (await filter(url, lastmod, true)) {
					log.debug(`Found subsitemap url`, { url });

					await requestQueue.addRequest({
						url,
					});
					count++;
				}
			}
		},
	});

	await sitemapCrawler.run();

	log.info(`Found ${urls.size} URLs from ${count} sitemap URLs`);

	return RequestList.open('STARTURLS', [...urls.values()]);
};

/**
 * @param {Record<string, any>[]} arr
 */
export const mapEntitiesById = (arr) => new Map([...arr].filter((s) => s).map((item) => ([stripShopifyGid(item.id), item])));

/**
 * @param {any[]} arr
 */
export const uniqueDefinedArray = (arr) => [...new Set([...arr])].filter((s) => s);

/**
 * @param {string} url
 */
export const stripUrlQuery = (url) => `${url}`.split('?', 2)[0];

/**
 *
 * @param {Record<string, any>} variant
 * @param {Record<string, any>} product
 * @returns {{ name: string, props: Record<string, any> }}
 */
export const deriveVariantAttributes = (variant, product) => {
	const { options } = product;

	if (/(Default|title)/i.test(`${options?.[0]?.name}`)) {
		return { name: 'Default', props: {} };
	}

	const name = [];
	const props = {};

	for (let i = 0; i < options.length; i++) {
		const prop = `option${i + 1}`;
		if (prop in variant) {
			props[toSnakeCase(options[i].name)] = variant[prop];
			name.push(`${options[i].name}: ${variant[prop]}`);
		}
	}

	return { name: name.join(' / '), props };
};

/**
 * Checks for robots to be of Shopify and parse the sitemap location
 *
 * @param {{
 *   filteredSitemapUrls: Set<string>,
 *   startUrls: Apify.RequestOptions[],
 *   proxyConfiguration: Apify.ProxyConfiguration,
 *   checkForBanner: boolean
 * }} params
 */
// robots.txt handling removed; sitemaps are provided directly via input

/**
 * @typedef {ReturnType<typeof compileExtendFunction> extends Promise<infer U> ? U : never} UnwrappedPromiseFn
 */

/**
 * Do a generic check when using Apify Proxy
 *
 * @typedef params
 * @property {any} [params.proxyConfig] Provided apify proxy configuration
 * @property {boolean} [params.required] Make the proxy usage required when running on the platform
 * @property {string[]} [params.blacklist] Blacklist of proxy groups, by default it's ['GOOGLE_SERP']
 * @property {boolean} [params.force] By default, it only do the checks on the platform. Force checking regardless where it's running
 * @property {string[]} [params.hint] Hint specific proxy groups that should be used, like SHADER or RESIDENTIAL
 *
 * @example
 *    const proxy = await proxyConfiguration({
 *       proxyConfig: input.proxy,
 *       blacklist: ['SHADER'],
 *       hint: ['RESIDENTIAL']
 *    });
 *
 * @param {params} params
 * @returns {Promise<Apify.ProxyConfiguration | undefined>}
 */
export const createProxyConfigurationChecked = async ({
	proxyConfig,
	required = true,
	force = Actor.isAtHome(),
	blacklist = ['GOOGLESERP'],
	hint = [],
}) => {
	const configuration = await Actor.createProxyConfiguration(proxyConfig);

	// this works for custom proxyUrls
	if (Actor.isAtHome() && required) {
		if (!configuration || (!configuration.usesApifyProxy && (!configuration.proxyUrls || !configuration.proxyUrls.length)) || !configuration.newUrl()) {
			throw new Error('\n=======\nYou must use Apify proxy or custom proxy URLs\n\n=======');
		}
	}

	// check when running on the platform by default
	if (force) {
		// only when actually using Apify proxy it needs to be checked for the groups
		if (configuration && configuration.usesApifyProxy) {
			if (blacklist.some((blacklisted) => (configuration.groups || []).includes(blacklisted))) {
				throw new Error(`\n=======\nThese proxy groups cannot be used in this actor. Choose other group or contact support@apify.com to give you proxy trial:\n\n*  ${blacklist.join('\n*  ')}\n\n=======`);
			}

			// specific non-automatic proxy groups like RESIDENTIAL, not an error, just a hint
			if (hint.length && !hint.some((group) => (configuration.groups || []).includes(group))) {
				log.info(`\n=======\nYou can pick specific proxy groups for better experience:\n\n*  ${hint.join('\n*  ')}\n\n=======`);
			}
		}
	}

	return configuration;
};

/**
 * @template T
 * @typedef {T & { Apify: Apify, customData: any, request: Apify.Request }} PARAMS
 */

/**
 * Compile a IO function for mapping, filtering and outputing items.
 * Can be used as a no-op for interaction-only (void) functions on `output`.
 * Data can be mapped and filtered twice.
 *
 * Provided base map and filter functions is for preparing the object for the
 * actual extend function, it will receive both objects, `data` as the "raw" one
 * and "item" as the processed one.
 *
 * Always return a passthrough function if no outputFunction provided on the
 * selected key.
 *
 * @template RAW
 * @template {{ [key: string]: any }} INPUT
 * @template MAPPED
 * @template {{ [key: string]: any }} HELPERS
 * @param {{
 *  key: string,
 *  map?: (data: RAW, params: PARAMS<HELPERS>) => Promise<MAPPED>,
 *  output?: (data: MAPPED, params: PARAMS<HELPERS> & { data: RAW, item: MAPPED }) => Promise<void>,
 *  filter?: (obj: { data: RAW, item: MAPPED }, params: PARAMS<HELPERS>) => Promise<boolean>,
 *  input: INPUT,
 *  helpers: HELPERS,
 * }} params
 * @return {Promise<(data: RAW, args?: Record<string, any>) => Promise<void>>}
 */
export const compileExtendFunction = async ({
	key,
	output,
	filter,
	map,
	input,
	helpers,
}) => {
	/**
	 * @type {PARAMS<HELPERS>}
	 */
	const base = {
		...helpers,
		Actor,
		customData: input.customData || {},
	};

	const evaledFn = (() => {
		// need to keep the same signature for no-op
		if (typeof input[key] !== 'string' || input[key].trim() === '') {
			return new vm.Script('({ item }) => item');
		}

		try {
			return new vm.Script(input[key], {
				lineOffset: 0,
				produceCachedData: false,
				displayErrors: true,
				filename: `${key}.js`,
			});
		} catch {
			throw new Error(`"${key}" parameter must be a function`);
		}
	})();

	/**
	 * Returning arrays from wrapper function split them accordingly.
	 * Normalize to an array output, even for 1 item.
	 *
	 * @param {any} value
	 * @param {any} [args]
	 */
	const splitMap = async (value, args) => {
		const mapped = map ? await map(value, args) : value;

		if (!Array.isArray(mapped)) {
			return [mapped];
		}

		return mapped;
	};

	return async (data, args) => {
		const merged = { ...base, ...args };

		for (const item of await splitMap(data, merged)) {
			if (filter && !(await filter({ data, item }, merged))) {
				continue;
			}

			const result = await (evaledFn.runInThisContext()({
				...merged,
				data,
				item,
			}));

			for (const out of (Array.isArray(result) ? result : [result])) {
				if (output && out !== null) {
					await output(out, { ...merged, data, item });
				}
			}
		}
	};
};
