// oc-dispatch — the grade store.
//
// One row per `providerID/modelID#taskClass`, kept on `ctx.storage` when the
// host exposes a get/set (or read/write) pair and in memory otherwise. Every
// access is best-effort: a missing storage surface degrades to "less memory",
// never to a failed resolve. Latencies are held in a bounded private array and
// the public row carries exactly the brief's keys.
export const gradeKey = (providerID, modelID, taskClass) => `${providerID}/${modelID}#${taskClass}`;

const BLANK = {
  samples: 0, ok: 0, fail: 0, timeouts: 0, costSum: 0, taskCount: 0,
  p50: 0, p95: 0, bankedUntil: 0, lastReason: '',
};
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const int = (v) => Math.max(0, Math.floor(num(v)));

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

export function createGradeStore(storage, { now = Date.now, maxSamples = 50 } = {}) {
  const memory = new Map();
  const api = storage && typeof storage === 'object' ? storage : {};
  const getFn = typeof api.get === 'function' ? api.get : typeof api.read === 'function' ? api.read : null;
  const setFn = typeof api.set === 'function' ? api.set : typeof api.write === 'function' ? api.write : null;

  function decode(value) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const row = { ...BLANK };
    for (const key of ['samples', 'ok', 'fail', 'timeouts', 'taskCount']) row[key] = int(raw[key]);
    row.costSum = num(raw.costSum);
    row.bankedUntil = num(raw.bankedUntil);
    row.lastReason = typeof raw.lastReason === 'string' ? raw.lastReason : '';
    const latencies = Array.isArray(raw._lat)
      ? raw._lat.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice(-maxSamples)
      : [];
    return { row, latencies };
  }

  function load(key) {
    const fallback = decode(memory.get(key));
    if (!getFn) return fallback;
    try {
      const value = getFn.call(api, key);
      // A promise-returning storage is not usable by a synchronous resolve hook.
      if (value && typeof value.then === 'function') return fallback;
      return decode(value ?? memory.get(key));
    } catch {
      return fallback;
    }
  }

  function save(key, row, latencies) {
    memory.set(key, { ...row, _lat: latencies });
    if (!setFn) return;
    try {
      setFn.call(api, key, { ...row, _lat: latencies });
    } catch {
      /* the memory copy still serves this process */
    }
  }

  function get(key) {
    const { row, latencies } = load(key);
    return {
      ...row,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    };
  }

  function record(key, sample = {}) {
    const { row, latencies } = load(key);
    const s = sample && typeof sample === 'object' ? sample : {};
    row.samples += 1;
    row.taskCount += 1;
    row.costSum += num(s.costUsd);
    if (s.timeout) {
      row.timeouts += 1;
      row.fail += 1;
    } else if (s.ok) row.ok += 1;
    else row.fail += 1;
    if (typeof s.reason === 'string') row.lastReason = s.reason;
    if (typeof s.ms === 'number' && Number.isFinite(s.ms)) {
      latencies.push(s.ms);
      if (latencies.length > maxSamples) latencies.splice(0, latencies.length - maxSamples);
    }
    save(key, row, latencies);
    return get(key);
  }

  function bank(key, untilMs) {
    const { row, latencies } = load(key);
    row.bankedUntil = num(untilMs);
    save(key, row, latencies);
    return get(key);
  }

  function isBanked(key) {
    return load(key).row.bankedUntil > now();
  }

  function keys() {
    return [...memory.keys()];
  }

  function bankedKeys() {
    return keys().filter(isBanked);
  }

  return { bank, bankedKeys, get, isBanked, keys, record };
}
