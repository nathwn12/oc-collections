import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openIndex, syncCorpus, search, coverage, collectFiles, activeRoots, VAULT_ROOT, SESSION_ROOT } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');

function client(env) {
  const opts = { stdio: ['pipe', 'pipe', 'pipe'], cwd: os.tmpdir() };
  if (env) opts.env = { ...process.env, ...env };
  const child = spawn(process.execPath, [SERVER], opts);
  let buf = '';
  let err = '';
  let id = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });
  child.stderr.on('data', (c) => { err += c.toString(); });
  function req(method, params) {
    return new Promise((resolve, reject) => {
      const mid = ++id;
      const t = setTimeout(() => reject(new Error(`timeout ${method}; stderr=${err}`)), 180000);
      pending.set(mid, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
    });
  }
  return { req, child, stderr: () => err };
}

const receipts = {};

const c = client();
const init = await c.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'receipt-client', version: '1' } });
receipts.initialize = init.result;
assert.equal(init.result.serverInfo.name, 'oc-recall-native');

const list = await c.req('tools/list', {});
receipts.toolsList = list.result;
assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['recall_coverage', 'recall_search']);

const hit = await c.req('tools/call', { name: 'recall_search', arguments: { query: 'Atlas Contract', limit: 3 } });
const hitVal = JSON.parse(hit.result.content[0].text);
receipts.recallSearch = hitVal;
assert.equal(hitVal.status, 'evidence-only');
assert.ok(hitVal.results.length > 0, 'search returned no results');
for (const r of hitVal.results) {
  assert.ok(path.isAbsolute(r.path), `path not absolute: ${r.path}`);
  if (!r.path.includes('::')) assert.ok(fs.existsSync(r.path), `path not on disk: ${r.path}`);
  assert.ok(Number.isInteger(r.line) && r.line > 0, `bad line: ${r.line}`);
}

const cov1 = JSON.parse((await c.req('tools/call', { name: 'recall_coverage', arguments: {} })).result.content[0].text);
const cov2 = JSON.parse((await c.req('tools/call', { name: 'recall_coverage', arguments: {} })).result.content[0].text);
receipts.coverage1 = cov1;
receipts.coverage2 = cov2;
assert.deepEqual(cov1, cov2, 'coverage changed with no corpus writes');
assert.ok(cov1.indexedFiles.note > 0 && cov1.indexedDocRows['session-db'] > 0, 'vault notes or session text not indexed');
c.child.stdin.end();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recall-native-'));
const vault = path.join(tmp, 'vault');
const sessDir = path.join(tmp, 'share');
const ses = path.join(sessDir, 'ses_mock');
fs.mkdirSync(vault, { recursive: true });
fs.mkdirSync(ses, { recursive: true });
const seed = new DatabaseSync(path.join(sessDir, 'opencode.db'));
seed.exec('CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
seed.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('p1', 'msg1', 'ses_mock', 1, 1, JSON.stringify({ type: 'text', text: 'incremental session marker phi zeta omega confirm' }));
seed.close();

const a = path.join(vault, 'a.md');
fs.writeFileSync(a, '# Alpha\n\ntreetop omega marker\n');
const db = openIndex(path.join(tmp, 'index.sqlite'));
syncCorpus(db, { vaultRoot: vault, sessionRoot: sessDir });
assert.ok(search(db, 'treetop omega', 3).results.length > 0, 'initial note not indexed');

fs.writeFileSync(path.join(vault, 'b.md'), '# Beta\n\nquartz delta marker\n');
syncCorpus(db, { vaultRoot: vault, sessionRoot: sessDir });
assert.ok(search(db, 'quartz delta', 3).results.some((r) => r.path.endsWith('b.md')), 'added note not indexed');

fs.writeFileSync(a, '# Alpha\n\nsaffron replaced marker text\n');
const drifted = coverage(db, { vaultRoot: vault, sessionRoot: sessDir });
assert.ok(drifted.driftCount > 0 && drifted.exact === false, 'coverage missed on-disk drift');
syncCorpus(db, { vaultRoot: vault, sessionRoot: sessDir });
const clean = coverage(db, { vaultRoot: vault, sessionRoot: sessDir });
assert.ok(clean.exact === true && clean.driftCount === 0, 'coverage did not return to exact after sync');
assert.equal(search(db, 'zzzqqqxxyy', 3).status, 'no-match', 'nonsense query matched');
assert.throws(() => collectFiles({ vaultRoot: path.join(tmp, 'absent') }), /vault root missing/);
assert.equal(search(db, 'treetop omega', 3).results.length, 0, 'modified note left stale rows');
assert.ok(search(db, 'saffron replaced', 3).results.length > 0, 'modified note not reindexed');
assert.ok(search(db, 'incremental session marker phi', 3).results.some((r) => r.source === 'session-db'), 'session text not indexed');

// Regression: batched, resumable session-db ingestion with bounded SELECTs.
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recall-batch-'));
const vault2 = path.join(tmp2, 'vault');
const sess2 = path.join(tmp2, 'share');
fs.mkdirSync(vault2, { recursive: true });
fs.mkdirSync(sess2, { recursive: true });
const seed2 = new DatabaseSync(path.join(sess2, 'opencode.db'));
seed2.exec('CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
const ins2 = seed2.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)');
for (let i = 1; i <= 4500; i++) {
  ins2.run(`p${i}`, `m${i}`, 'ses_batch', 1, 1, JSON.stringify({ type: 'text', text: `batch marker row ${i} lorem ipsum dolor sit amet consectetur` }));
}
seed2.close();
const db2 = openIndex(path.join(tmp2, 'index.sqlite'));
db2.prepare("INSERT INTO meta(key,value) VALUES('partRowid','1000')").run();
const first = syncCorpus(db2, { vaultRoot: vault2, sessionRoot: sess2 }).sessionDb;
assert.equal(first.targetMaxRowid, 4500, 'target max rowid not reported');
assert.equal(first.maxRowid, 4500, 'watermark not advanced to max');
assert.equal(first.added, 3500, 'resume did not index only rows beyond watermark');
assert.ok(first.batches >= 2, 'scan was not batched');
assert.equal(first.tailDrift, 0, 'unexpected tail drift');
assert.ok(!search(db2, 'row 1 lorem', 5).results.some((r) => r.path.endsWith('::1')), 'pre-watermark row indexed');
assert.ok(search(db2, 'row 2000 lorem', 5).results.length > 0, 'post-watermark row missing');
const second = syncCorpus(db2, { vaultRoot: vault2, sessionRoot: sess2 }).sessionDb;
assert.equal(second.added, 0, 're-scan re-indexed rows');
const dbCount = Number(db2.prepare("SELECT COUNT(*) AS n FROM docs WHERE source='session-db'").get()?.n);
assert.equal(dbCount, 3500, 'duplicate or missing session-db docs after re-scan');
const seed3 = new DatabaseSync(path.join(sess2, 'opencode.db'));
seed3.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('p4501', 'm4501', 'ses_batch', 1, 1, JSON.stringify({ type: 'text', text: 'live tail marker row 4501 lorem ipsum dolor sit amet' }));
seed3.close();
const third = syncCorpus(db2, { vaultRoot: vault2, sessionRoot: sess2 }).sessionDb;
assert.equal(third.added, 1, 'live tail row not indexed');
assert.equal(third.maxRowid, 4501, 'watermark did not follow live tail');
assert.equal(third.tailDrift, 0, 'tail drift reported when tail already consumed');
db2.close();
receipts.batchedIngestion = { first, second, third, docCount: dbCount };

// Regression: batched, resumable session_message ingestion with bounded SELECTs.
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recall-msg-'));
const vault3 = path.join(tmp3, 'vault');
const sess3 = path.join(tmp3, 'share');
fs.mkdirSync(vault3, { recursive: true });
fs.mkdirSync(sess3, { recursive: true });
const seedMsg = new DatabaseSync(path.join(sess3, 'opencode.db'));
seedMsg.exec('CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
seedMsg.exec('CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)');
const insMsg = seedMsg.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)');
for (let i = 1; i <= 4500; i++) {
  insMsg.run(`m${i}`, 'ses_msg', 'user', i, 1, 1, JSON.stringify({ text: `message marker row ${i} lorem ipsum dolor sit amet consectetur`, time: { created: 1 } }));
}
seedMsg.close();
const db3 = openIndex(path.join(tmp3, 'index.sqlite'));
db3.prepare("INSERT INTO meta(key,value) VALUES('messageRowid','1000')").run();
const mFirst = syncCorpus(db3, { vaultRoot: vault3, sessionRoot: sess3 }).sessionMessageDb;
assert.equal(mFirst.targetMaxRowid, 4500, 'message target max rowid not reported');
assert.equal(mFirst.maxRowid, 4500, 'message watermark not advanced to max');
assert.equal(mFirst.added, 3500, 'message resume did not index only rows beyond watermark');
assert.ok(mFirst.batches >= 2, 'message scan was not batched');
assert.equal(mFirst.tailDrift, 0, 'unexpected message tail drift');
assert.ok(!search(db3, 'row 1 lorem', 5).results.some((r) => r.path.endsWith('::1')), 'pre-watermark message row indexed');
assert.ok(search(db3, 'row 2000 lorem', 5).results.some((r) => r.source === 'session-db-message'), 'post-watermark message row missing');
const mSecond = syncCorpus(db3, { vaultRoot: vault3, sessionRoot: sess3 }).sessionMessageDb;
assert.equal(mSecond.added, 0, 'message re-scan re-indexed rows');
const mCount = Number(db3.prepare("SELECT COUNT(*) AS n FROM docs WHERE source='session-db-message'").get()?.n);
assert.equal(mCount, 3500, 'duplicate or missing message docs after re-scan');
const seedMsg2 = new DatabaseSync(path.join(sess3, 'opencode.db'));
seedMsg2.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)').run('m4501', 'ses_msg', 'user', 4501, 1, 1, JSON.stringify({ text: 'live tail message row 4501 lorem ipsum dolor sit amet' }));
seedMsg2.close();
const mThird = syncCorpus(db3, { vaultRoot: vault3, sessionRoot: sess3 }).sessionMessageDb;
assert.equal(mThird.added, 1, 'live message tail row not indexed');
assert.equal(mThird.maxRowid, 4501, 'message watermark did not follow live tail');
assert.equal(mThird.tailDrift, 0, 'message tail drift reported when tail already consumed');

// Dedupe: an identical text already indexed by the part pass is overlap-skipped.
const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recall-overlap-'));
const vault4 = path.join(tmp4, 'vault');
const sess4 = path.join(tmp4, 'share');
fs.mkdirSync(vault4, { recursive: true });
fs.mkdirSync(sess4, { recursive: true });
const ovSeed = new DatabaseSync(path.join(sess4, 'opencode.db'));
ovSeed.exec('CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
ovSeed.exec('CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)');
const shared = 'overlap marker zeta epsilon eta theta iota kappa lambda mu nu xi omicron pi rho sigma';
ovSeed.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('p1', 'msg1', 'ses_ov', 1, 1, JSON.stringify({ type: 'text', text: shared }));
ovSeed.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?,?)').run('m1', 'ses_ov', 'user', 1, 1, 1, JSON.stringify({ text: shared }));
ovSeed.close();
const db4 = openIndex(path.join(tmp4, 'index.sqlite'));
const ovResult = syncCorpus(db4, { vaultRoot: vault4, sessionRoot: sess4 });
assert.equal(ovResult.sessionMessageDb.overlapSkipped, 1, 'part/message text overlap was not skipped');
assert.equal(ovResult.sessionMessageDb.added, 0, 'overlapping message was indexed twice');
db4.close();

db3.close();
receipts.messageIngestion = { mFirst, mSecond, mThird, docCount: mCount, overlapSkipped: ovResult.sessionMessageDb.overlapSkipped };
receipts.incremental = { tempPrefix: tmp, noteAdded: true, noteModified: true, sessionTextIndexed: true };
db.close();

// Regression: env overrides change the active roots; defaults hold when unset.
const savedVault = process.env.OC_RECALL_VAULT;
const savedData = process.env.OC_RECALL_DATA;
delete process.env.OC_RECALL_VAULT;
delete process.env.OC_RECALL_DATA;
assert.deepEqual(activeRoots(), { vaultRoot: VAULT_ROOT, sessionRoot: SESSION_ROOT }, 'defaults changed when env unset');
assert.throws(() => collectFiles({ vaultRoot: path.join(os.tmpdir(), 'oc-recall-no-such-vault') }), /vault root missing[\s\S]*OC_RECALL_VAULT/);

const envTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recall-env-'));
const envVault = path.join(envTmp, 'vault');
const envData = path.join(envTmp, 'data');
fs.mkdirSync(envVault, { recursive: true });
fs.mkdirSync(envData, { recursive: true });
fs.writeFileSync(path.join(envVault, 'env.md'), '# Env\n\nenv override marker treetop\n');
const envSeed = new DatabaseSync(path.join(envData, 'opencode.db'));
envSeed.exec('CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
envSeed.close();

process.env.OC_RECALL_VAULT = envVault;
process.env.OC_RECALL_DATA = envData;
assert.deepEqual(activeRoots(), { vaultRoot: envVault, sessionRoot: envData }, 'env override not applied');
assert.throws(() => collectFiles({ vaultRoot: envVault, sessionRoot: path.join(envTmp, 'no-data') }), /session root missing[\s\S]*OC_RECALL_DATA/);
assert.ok(collectFiles().some((f) => f.path.endsWith('env.md')), 'env vault not used by collectFiles with no explicit roots');

const cEnv = client({ OC_RECALL_VAULT: envVault, OC_RECALL_DATA: envData });
const envCov = JSON.parse((await cEnv.req('tools/call', { name: 'recall_coverage', arguments: {} })).result.content[0].text);
assert.deepEqual(envCov.roots, { vaultRoot: envVault, sessionRoot: envData }, 'recall_coverage did not report active roots');
assert.equal(envCov.onDiskFiles.note, 1, 'env vault note not seen by coverage');
const envHit = JSON.parse((await cEnv.req('tools/call', { name: 'recall_search', arguments: { query: 'env override marker', limit: 3 } })).result.content[0].text);
assert.ok(envHit.results.some((r) => r.path.startsWith(envVault)), 'recall_search did not use env vault');
cEnv.child.stdin.end();

if (savedVault === undefined) delete process.env.OC_RECALL_VAULT; else process.env.OC_RECALL_VAULT = savedVault;
if (savedData === undefined) delete process.env.OC_RECALL_DATA; else process.env.OC_RECALL_DATA = savedData;
receipts.envOverride = { defaults: { vaultRoot: VAULT_ROOT, sessionRoot: SESSION_ROOT }, active: { vaultRoot: envVault, sessionRoot: envData }, coverageRoots: envCov.roots };

// Regression: init mode builds the corpus in the foreground and resumes.
const initTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recall-init-'));
const initVault = path.join(initTmp, 'vault');
const initData = path.join(initTmp, 'data');
fs.mkdirSync(initVault, { recursive: true });
fs.mkdirSync(initData, { recursive: true });
fs.writeFileSync(path.join(initVault, 'init.md'), '# Init\n\ninit marker treetop delta\n');
const initSeed = new DatabaseSync(path.join(initData, 'opencode.db'));
initSeed.exec('CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
const initIns = initSeed.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)');
for (let i = 1; i <= 3; i++) {
  initIns.run(`i${i}`, `im${i}`, 'ses_init', 1, 1, JSON.stringify({ type: 'text', text: `init session row ${i} lorem ipsum dolor sit amet consectetur` }));
}
initSeed.close();
const initEnv = { ...process.env, OC_RECALL_VAULT: initVault, OC_RECALL_DATA: initData };
const initRun = spawnSync(process.execPath, [SERVER, 'init'], { env: initEnv, encoding: 'utf8' });
assert.equal(initRun.status, 0, `init exited ${initRun.status}; stderr=${initRun.stderr}`);
assert.match(initRun.stdout, /vault root: .*\(OC_RECALL_VAULT\)/);
assert.match(initRun.stdout, /data root:  .*\(OC_RECALL_DATA\)/);
assert.match(initRun.stdout, /notes: 1 files on disk/);
assert.match(initRun.stdout, /session-db part: \+3 rows, batch 1\/\d+/);
assert.match(initRun.stdout, /DONE: notes indexed=1; session rows added=3 \(part=3, messages=0, post-dedupe\); index=/);
const initResume = spawnSync(process.execPath, [SERVER, 'init'], { env: initEnv, encoding: 'utf8' });
assert.equal(initResume.status, 0, `init resume exited ${initResume.status}; stderr=${initResume.stderr}`);
assert.match(initResume.stdout, /DONE: notes indexed=1; session rows added=0 \(part=0, messages=0, post-dedupe\); index=/);
const initStop = spawnSync(process.execPath, [SERVER, 'init'], {
  env: { ...initEnv, OC_RECALL_VAULT: path.join(initTmp, 'no-vault') }, encoding: 'utf8',
});
assert.equal(initStop.status, 1, 'init missing root did not exit 1');
assert.match(initStop.stderr, /^STOP: vault root missing; create .*no-vault \(set OC_RECALL_VAULT\)/);
receipts.init = initRun.stdout.trim();

console.log('==BEGIN RECEIPTS==');
console.log(JSON.stringify(receipts, null, 2));
console.log('==END RECEIPTS==');
console.log('ALL ASSERTIONS PASSED');
