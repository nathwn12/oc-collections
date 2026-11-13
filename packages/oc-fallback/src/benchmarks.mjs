/**
 * oc-fallback - the published-benchmark check.
 *
 * The owner's rule is zero-benchmarks-locally: a rung that advertises no
 * benchmark on the public site is not a fallback, it is an unknown quantity.
 * The site lists one page per model in `sitemap.xml` as
 * `https://opencode.ai/data/<lab>/<model-slug>`, and that page's `.json` carries
 * `model.benchmarks` as an array. An empty array is the rejection.
 *
 * The slug is the model id with dots turned into dashes (`deepseek-v4.1-flash`
 * -> `deepseek-v4-1-flash`); the lab is not in the id, so the sitemap is the
 * lookup table. The sitemap and every page answer are cached for the config's
 * `benchmarkTtlMs`, because a ladder is read far more often than it changes.
 *
 * Fail open, always: an unreachable site, a page that is not in the sitemap, a
 * body that is not JSON, or a `benchmarks` field that is not an array all answer
 * `unknown`, which the rules let through. Only a reachable page that says, in
 * the shape the site defines, "no benchmarks" earns a rejection.
 */

/** `deepseek-v4.1-flash` -> `deepseek-v4-1-flash`, the site's slug for it. */
export function modelSlug(id) {
  return String(id ?? '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '-');
}

/**
 * Every model page in the sitemap, keyed by slug. Lab landing pages carry no
 * second path segment and comparison pages are not a model, so both are dropped:
 * only `<lab>/<slug>` is a model page.
 */
export function sitemapIndex(xml) {
  const index = new Map();
  for (const match of String(xml ?? '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = match[1];
    if (url.includes('/compare/')) continue;
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'data') continue;
    const slug = parts[2];
    if (!index.has(slug)) index.set(slug, url.replace(/\/+$/, ''));
  }
  return index;
}

const UNKNOWN = (reason) => ({ state: 'unknown', count: 0, url: null, reason });

/**
 * A cached view of the site. `status(modelID)` answers
 * `{ state: 'benchmarked' | 'zero' | 'unknown', count, url }` and never throws.
 */
export function createCatalog({
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = 6 * 60 * 60 * 1000,
  sitemapUrl = 'https://opencode.ai/data/sitemap.xml',
  timeoutMs = 4000,
} = {}) {
  let indexCache = null; // { at, index: Map | null }
  const pageCache = new Map(); // slug -> { at, result }

  const fresh = (entry) => entry && now() - entry.at < ttlMs;

  async function body(url) {
    if (typeof fetchImpl !== 'function') return null;
    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
      const response = await fetchImpl(url, { signal });
      if (!response?.ok) return null;
      return await response.text();
    } catch {
      return null; // a dead network is not a verdict about a model
    }
  }

  async function index() {
    if (fresh(indexCache)) return indexCache.index;
    const xml = await body(sitemapUrl);
    const index = xml === null ? null : sitemapIndex(xml);
    indexCache = { at: now(), index };
    return index;
  }

  async function status(modelID) {
    try {
      const slug = modelSlug(String(modelID ?? '').split('/').pop());
      if (!slug) return UNKNOWN('no-slug');
      const cached = pageCache.get(slug);
      if (fresh(cached)) return cached.result;

      const pages = await index();
      if (!pages) {
        const result = UNKNOWN('sitemap-unreachable');
        pageCache.set(slug, { at: now(), result });
        return result;
      }
      const page = pages.get(slug);
      if (!page) {
        const result = UNKNOWN('no-page');
        pageCache.set(slug, { at: now(), result });
        return result;
      }

      const text = await body(`${page}.json`);
      if (text === null) {
        const result = UNKNOWN('page-unreachable');
        pageCache.set(slug, { at: now(), result });
        return result;
      }

      let benchmarks;
      try {
        benchmarks = JSON.parse(text)?.model?.benchmarks;
      } catch {
        const result = UNKNOWN('page-unreadable');
        pageCache.set(slug, { at: now(), result });
        return result;
      }
      if (!Array.isArray(benchmarks)) {
        const result = UNKNOWN('benchmarks-absent');
        pageCache.set(slug, { at: now(), result });
        return result;
      }
      const result =
        benchmarks.length > 0
          ? { state: 'benchmarked', count: benchmarks.length, url: `${page}.json` }
          : { state: 'zero', count: 0, url: `${page}.json` };
      pageCache.set(slug, { at: now(), result });
      return result;
    } catch {
      return UNKNOWN('check-failed');
    }
  }

  return { status };
}
