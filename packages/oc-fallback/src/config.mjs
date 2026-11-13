/**
 * oc-fallback - the configuration half.
 *
 * One file, one shape, one place. Everything the plugin does is decided here:
 * the provider it will never cross, the ladders it steps down, the rules a rung
 * must pass, and where it writes. A missing or broken file is not an error: the
 * built-in defaults stand in and one log line says the file was not read, so a
 * typo in a config can never cost a session.
 *
 * The ladders have two shapes and exactly one truth. Inline, they live in this
 * file. By pointer, they live in another JSON file (`{ file, key }`) that this
 * module only ever READS: the fleet's `harness.json` stays the single owner of
 * which model serves which seat, and this package never copies or writes it.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything the owner can bend without touching code. */
export const DEFAULTS = {
  enabled: true,
  provider: 'opencode-go',
  ladders: {},
  rules: {
    autoFailover: false,
    excludeFree: true,
    requirePublishedBenchmark: true,
    maxInputUsd: 0.15,
    maxOutputUsd: 0.6,
    rungMayNotCostMoreThanPinned: false,
  },
  logPath: join(homedir(), '.local', 'share', 'opencode', 'log', 'oc-fallback.log'),
  sitemapUrl: 'https://opencode.ai/data/sitemap.xml',
  benchmarkTtlMs: 6 * 60 * 60 * 1000,
};

/** The default config file: `OC_FALLBACK_CONFIG` overrides it. */
export function configPath(env = {}, home = homedir()) {
  const override = env?.OC_FALLBACK_CONFIG;
  if (typeof override === 'string' && override.trim()) return override.trim();
  return join(home, '.config', 'opencode', 'oc-fallback.json');
}

/** The kill switch: anything but an explicit `off` leaves the plugin on. */
export function killSwitch(env = {}) {
  return String(env?.OC_FALLBACK ?? '').trim().toLowerCase() === 'off';
}

/** "provider/model" -> both halves, split on the FIRST slash only. */
export function splitModel(id) {
  if (typeof id !== 'string') return null;
  const at = id.indexOf('/');
  if (at <= 0 || at === id.length - 1) return null;
  return { providerID: id.slice(0, at), id: id.slice(at + 1) };
}

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/** A price cap: `null` turns that test off; anything unreadable keeps the default. */
function cap(value, fallback) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function laddersOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  if (typeof raw.file === 'string') return raw; // a pointer, resolved by readLadders
  const out = {};
  for (const [agent, rungs] of Object.entries(raw)) {
    if (!Array.isArray(rungs)) continue;
    const clean = rungs.filter((rung) => typeof rung === 'string' && splitModel(rung) !== null);
    if (clean.length) out[agent] = clean;
  }
  return out;
}

/**
 * A config object from whatever the file held. Never throws: a string where an
 * object belongs, a rule of the wrong type, a missing key all fall back to the
 * default for that one field.
 */
export function normalize(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rules = source.rules && typeof source.rules === 'object' ? source.rules : {};
  const ttl = source.benchmarkTtlMs;
  return {
    enabled: bool(source.enabled, DEFAULTS.enabled),
    provider:
      typeof source.provider === 'string' && source.provider.trim()
        ? source.provider.trim()
        : DEFAULTS.provider,
    ladders: laddersOf(source.ladders),
    rules: {
      autoFailover: bool(rules.autoFailover, DEFAULTS.rules.autoFailover),
      excludeFree: bool(rules.excludeFree, DEFAULTS.rules.excludeFree),
      requirePublishedBenchmark: bool(
        rules.requirePublishedBenchmark,
        DEFAULTS.rules.requirePublishedBenchmark,
      ),
      maxInputUsd: cap(rules.maxInputUsd, DEFAULTS.rules.maxInputUsd),
      maxOutputUsd: cap(rules.maxOutputUsd, DEFAULTS.rules.maxOutputUsd),
      rungMayNotCostMoreThanPinned: bool(
        rules.rungMayNotCostMoreThanPinned,
        DEFAULTS.rules.rungMayNotCostMoreThanPinned,
      ),
    },
    logPath:
      typeof source.logPath === 'string' && source.logPath.trim() ? source.logPath.trim() : DEFAULTS.logPath,
    sitemapUrl:
      typeof source.sitemapUrl === 'string' && source.sitemapUrl.trim()
        ? source.sitemapUrl.trim()
        : DEFAULTS.sitemapUrl,
    benchmarkTtlMs: typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULTS.benchmarkTtlMs,
  };
}

/**
 * The config, its source, and the one problem worth a log line. `source` is
 * `file` when the owner's file was read and `default` when it was not; the
 * plugin still works in the second case, with no ladders, hence no tools.
 */
export function loadConfig({ env = {}, read = (file) => readFileSync(file, 'utf8'), home = homedir() } = {}) {
  const file = configPath(env, home);
  let text;
  try {
    text = read(file);
  } catch {
    return { config: normalize(DEFAULTS), source: 'default', problem: 'config-unreadable', file };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { config: normalize(DEFAULTS), source: 'default', problem: 'config-unreadable', file };
  }
  return { config: normalize(parsed), source: 'file', problem: null, file };
}

/**
 * A `{ agent: [rung, ...] }` map from either ladder shape, and the problem when
 * there is none. The pointer form is read, never copied: the file it names
 * stays the only record of the fleet's ladders.
 */
export function readLadders(spec, { read = (file) => readFileSync(file, 'utf8') } = {}) {
  if (spec && typeof spec === 'object' && typeof spec.file === 'string') {
    const key = typeof spec.key === 'string' && spec.key.trim() ? spec.key.trim() : 'fallbacks';
    let parsed;
    try {
      parsed = JSON.parse(read(spec.file));
    } catch {
      return { ladders: {}, problem: 'ladders-unreadable', source: spec.file };
    }
    const raw = parsed?.[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ladders: {}, problem: 'ladders-missing', source: spec.file };
    }
    const ladders = laddersOf(raw);
    return Object.keys(ladders).length
      ? { ladders, problem: null, source: spec.file }
      : { ladders: {}, problem: 'ladders-missing', source: spec.file };
  }
  const ladders = laddersOf(spec);
  return Object.keys(ladders).length
    ? { ladders, problem: null, source: 'inline' }
    : { ladders: {}, problem: 'ladders-missing', source: 'inline' };
}
