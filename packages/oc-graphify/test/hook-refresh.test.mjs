import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configPath, MARKER } from '../lib.js'
import plugin from '../index.js'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (condition, message) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (condition()) return
    await pause(50)
  }
  assert.fail(message)
}

function atlasFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-graphify-hook-'))
  const atlas = path.join(root, 'atlas')
  const tools = path.join(atlas, '.graphify', 'tools')
  const graphOut = path.join(atlas, 'graphify-out')
  fs.mkdirSync(tools, { recursive: true })
  fs.mkdirSync(graphOut, { recursive: true })
  fs.writeFileSync(path.join(graphOut, 'graph.json'), JSON.stringify({
    nodes: [{ id: 'n', community: 1 }],
    links: [],
    built_at_commit: 'a'.repeat(40),
  }))
  const modeFile = path.join(root, 'mode')
  const countFile = path.join(root, 'count')
  const doneFile = path.join(root, 'done')
  fs.writeFileSync(modeFile, 'fresh')
  fs.writeFileSync(countFile, '0')
  fs.writeFileSync(doneFile, '0')
  const script = `
    import fs from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    const count = Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8') || '0');
    fs.writeFileSync(${JSON.stringify(countFile)}, String(count + 1));
    await delay(250);
    const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8');
    fs.writeFileSync(${JSON.stringify(doneFile)}, String(count + 1));
    if (mode === 'stale') { console.error('graph-freshness: graph is stale (fixture)'); process.exit(1); }
    if (mode === 'unknown') process.exit(2);
    console.log('graph fresh: fixture');
  `
  fs.writeFileSync(path.join(tools, 'graph-freshness.mjs'), script)
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ atlas }))
  return { root, atlas, modeFile, countFile, config: path.join(root, 'config.json') }
}

function installHooks(config) {
  const previous = process.env.OC_GRAPHIFY_CONFIG
  process.env.OC_GRAPHIFY_CONFIG = config
  const hooks = new Map()
  plugin.setup({ session: { hook: (name, fn) => hooks.set(name, fn) } })
  if (previous === undefined) delete process.env.OC_GRAPHIFY_CONFIG
  else process.env.OC_GRAPHIFY_CONFIG = previous
  return hooks
}

const event = () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
const state = (request) => request.messages[0].content.find((part) => part.text.startsWith(MARKER)).text.split('\n').at(-1)

test('request hooks return immediately, share one slow probe, and refresh stale/unknown without rejection', async () => {
  const fixture = atlasFixture()
  const hooks = installHooks(fixture.config)
  const inject = hooks.get('context')
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const originalNow = Date.now
  let now = 100_000
  Date.now = () => now
  try {
    const concurrent = ['context', 'compaction', 'generate'].map((name) => {
      const request = event()
      const started = performance.now()
      hooks.get(name)(request)
      assert.ok(performance.now() - started < 100, 'hook must not wait for child probes')
      assert.match(state(request), /unverified/, 'initial cache is explicitly unknown')
      return request
    })
    assert.equal(concurrent.length, 3)
    await waitFor(() => fs.readFileSync(path.join(fixture.root, 'done'), 'utf8') === '1', 'first freshness process did not finish')
    await waitFor(() => {
      const request = event()
      inject(request)
      return /fresh - fixture/.test(state(request))
    }, 'fresh verdict was not cached')
    assert.equal(fs.readFileSync(fixture.countFile, 'utf8'), '1', 'overlapping hooks share the in-flight refresh')

    const fresh = event()
    inject(fresh)
    assert.match(state(fresh), /fresh - fixture/)

    fs.writeFileSync(fixture.modeFile, 'stale')
    now += 61_000
    const duringStale = event()
    inject(duringStale)
    assert.match(state(duringStale), /fresh/, 'the last completed verdict remains cached during refresh')
    await waitFor(() => fs.readFileSync(path.join(fixture.root, 'done'), 'utf8') === '2', 'stale freshness process did not finish')
    let stale
    await waitFor(() => {
      stale = event()
      inject(stale)
      return /STALE/.test(state(stale))
    }, 'stale verdict was not cached')
    assert.match(state(stale), /STALE - graph is stale \(fixture\)/)

    fs.writeFileSync(fixture.modeFile, 'unknown')
    now += 61_000
    inject(event())
    await waitFor(() => fs.readFileSync(path.join(fixture.root, 'done'), 'utf8') === '3', 'failed freshness process did not finish')
    let unknown
    await waitFor(() => {
      unknown = event()
      inject(unknown)
      return /unverified/.test(state(unknown))
    }, 'failed refresh did not become unknown')
    assert.match(state(unknown), /unverified/, 'a failed refresh cannot inherit a fresh verdict')
    assert.equal(fs.readFileSync(fixture.countFile, 'utf8'), '3')
    assert.deepEqual(unhandled, [])
  } finally {
    Date.now = originalNow
    process.off('unhandledRejection', onUnhandled)
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a stuck freshness child does not block hook delivery', () => {
  const fixture = atlasFixture()
  const tool = path.join(fixture.atlas, '.graphify', 'tools', 'graph-freshness.mjs')
  fs.writeFileSync(tool, `await new Promise((resolve) => setTimeout(resolve, 1500)); console.log('graph fresh: late')`)
  const hook = installHooks(fixture.config).get('context')
  const request = event()
  const started = performance.now()
  hook(request)
  assert.ok(performance.now() - started < 100)
  assert.match(state(request), /unverified/)
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

test('graph replacement during freshness probe invalidates the verdict for the earlier bytes', async () => {
  const fixture = atlasFixture()
  const hooks = installHooks(fixture.config)
  const hook = hooks.get('context')
  hook(event())
  await waitFor(() => fs.readFileSync(fixture.countFile, 'utf8') === '1', 'probe did not start')
  const graphFile = path.join(fixture.atlas, 'graphify-out', 'graph.json')
  fs.writeFileSync(graphFile, JSON.stringify({
    nodes: [{ id: 'new-a' }, { id: 'new-b' }],
    links: [],
    built_at_commit: 'b'.repeat(40),
  }))
  await waitFor(() => fs.readFileSync(path.join(fixture.root, 'done'), 'utf8') === '1', 'probe did not finish')
  let request
  await waitFor(() => {
    request = event()
    hook(request)
    return /2 nodes/.test(request.messages[0].content[0].text)
  }, 'replacement graph was not cached')
  const block = request.messages[0].content[0].text
  assert.match(block, /2 nodes/, 'the refreshed counts come from the replacement file')
  assert.match(state(request), /unverified/, 'a probe racing a rebuild cannot certify different graph bytes')
  fs.rmSync(fixture.root, { recursive: true, force: true })
})
