import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MAINTENANCE_ARGS,
  MAINTENANCE_ENTRY,
  maintenanceDecision,
  maybeMaintain,
} from '../lib.js'
import plugin from '../index.js'

const waitFor = async (condition, message) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

// A detached child may still hold its fixture as cwd when the test finishes;
// Windows refuses to remove that directory until the handle is gone.
const removeFixture = (root) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { fs.rmSync(root, { recursive: true, force: true }); return }
    catch (error) {
      if (error.code !== 'EPERM') throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

function fixture({ stale = true, withEntry = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-graphify-maint-'))
  const atlas = path.join(root, 'atlas')
  const tools = path.join(atlas, '.graphify', 'tools')
  const out = path.join(atlas, 'graphify-out')
  fs.mkdirSync(tools, { recursive: true })
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'graph.json'), JSON.stringify({
    nodes: [{ id: 'n', community: 1 }],
    links: [],
    built_at_commit: 'a'.repeat(40),
  }))
  fs.writeFileSync(path.join(tools, 'graph-freshness.mjs'), stale
    ? `console.error('graph-freshness: graph is stale (fixture)'); process.exit(1)\n`
    : `console.log('graph fresh: fixture')\n`)
  const marker = path.join(root, 'maintenance.log')
  if (withEntry) {
    fs.writeFileSync(path.join(tools, 'atlas.mjs'), [
      `import fs from 'node:fs'`,
      `fs.appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n')`,
    ].join('\n'))
  }
  const config = path.join(root, 'config.json')
  fs.writeFileSync(config, JSON.stringify({ atlas }))
  return { root, atlas, marker, config }
}

test('maintenanceDecision: only a stale verdict starts work, and only once', () => {
  assert.deepEqual(maintenanceDecision({ state: 'stale', detail: 'changed input' }),
    { run: true, why: 'changed input' })
  assert.equal(maintenanceDecision({ state: 'stale' }, true).run, false)
  for (const fresh of [null, { state: 'fresh' }, { state: 'unknown' }, { state: 'missing' }]) {
    assert.equal(maintenanceDecision(fresh).run, false)
  }
})

test('maybeMaintain: one detached hidden spawn, with the vault entry point arguments', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-graphify-spawn-'))
  const atlas = path.join(root, 'atlas')
  fs.mkdirSync(path.join(atlas, '.graphify', 'tools'), { recursive: true })
  fs.writeFileSync(path.join(atlas, MAINTENANCE_ENTRY), '')
  const calls = []
  const child = { unref() { calls.push('unref') }, on() {} }
  const state = {}
  const spawnTool = (runtime, args, options) => {
    calls.push({ runtime, args, options })
    return child
  }
  try {
    const first = maybeMaintain(atlas, { state: 'stale', detail: 'changed' }, { runtime: 'node', spawnTool, state })
    assert.equal(first.started, true)
    assert.equal(calls.length, 2, 'one spawn call plus unref')
    assert.deepEqual(calls[0].args, [path.join(atlas, MAINTENANCE_ENTRY), ...MAINTENANCE_ARGS])
    assert.equal(calls[0].options.detached, true)
    assert.equal(calls[0].options.windowsHide, true)
    assert.equal(calls[0].options.cwd, atlas)

    maybeMaintain(atlas, { state: 'stale', detail: 'changed again' }, { runtime: 'node', spawnTool, state })
    assert.equal(calls.length, 2, 'a second call in the same state must not spawn')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('maybeMaintain: fresh, unknown, missing tool, and non-JS runtime never spawn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-graphify-nospawn-'))
  const atlas = path.join(root, 'atlas')
  let calls = 0
  const spawnTool = () => { calls += 1; return { unref() {}, on() {} } }
  try {
    for (const fresh of [null, { state: 'fresh' }, { state: 'unknown' }]) {
      assert.equal(maybeMaintain(atlas, fresh, { runtime: 'node', spawnTool }).started, false)
    }
    assert.equal(maybeMaintain(atlas, { state: 'stale' }, { runtime: 'node', spawnTool }).started, false)
    fs.mkdirSync(path.join(atlas, '.graphify', 'tools'), { recursive: true })
    fs.writeFileSync(path.join(atlas, MAINTENANCE_ENTRY), '')
    assert.equal(maybeMaintain(atlas, { state: 'stale' }, { runtime: 'opencode.exe', spawnTool }).started, false)
    assert.equal(calls, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('session hook: a stale verdict starts the real detached entry point without blocking', async () => {
  const fx = fixture({ stale: true })
  const previous = process.env.OC_GRAPHIFY_CONFIG
  process.env.OC_GRAPHIFY_CONFIG = fx.config
  const hooks = new Map()
  try {
    plugin.setup({ session: { hook: (name, fn) => hooks.set(name, fn) } })
    const event = () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
    const started = performance.now()
    const request = event()
    hooks.get('context')(request)
    assert.ok(performance.now() - started < 100, 'the hook must not wait for maintenance')
    await waitFor(() => fs.existsSync(fx.marker), 'stale verdict did not start the entry point')
    assert.match(fs.readFileSync(fx.marker, 'utf8'), new RegExp(`${MAINTENANCE_ARGS.join(' ')}\\n?$`))
    // The injected block still reports stale. Maintenance is a side effect,
    // not a change to the bytes the host receives.
    await waitFor(() => {
      const next = event()
      hooks.get('context')(next)
      return /STALE/.test(next.messages[0].content[0].text)
    }, 'stale state line never arrived')
  } finally {
    if (previous === undefined) delete process.env.OC_GRAPHIFY_CONFIG
    else process.env.OC_GRAPHIFY_CONFIG = previous
    removeFixture(fx.root)
  }
})

test('session hook: a fresh verdict starts nothing', async () => {
  const fx = fixture({ stale: false })
  const previous = process.env.OC_GRAPHIFY_CONFIG
  process.env.OC_GRAPHIFY_CONFIG = fx.config
  const hooks = new Map()
  try {
    plugin.setup({ session: { hook: (name, fn) => hooks.set(name, fn) } })
    hooks.get('context')({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(fs.existsSync(fx.marker), false, 'a fresh graph must not start maintenance')
  } finally {
    if (previous === undefined) delete process.env.OC_GRAPHIFY_CONFIG
    else process.env.OC_GRAPHIFY_CONFIG = previous
    removeFixture(fx.root)
  }
})
