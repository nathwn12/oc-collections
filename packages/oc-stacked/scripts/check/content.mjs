/**
 * The content the plugin ships: skills, their ids and front matter, the
 * bootstrap shape and budget, OWNER.md, commands, and the lineage pointer.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readSkills } from '../../lib/content.js';
import { bootstrap, MARKER } from '../../lib/bootstrap.js';

export function register(ctx) {
  const { check, assert, repo } = ctx;

  // ---------------------------------------------------------------- skills
  const skills = readSkills();

  check('sixteen skills register', () => {
    const expected = [
      'stacked',
      'stacked-soul',
      'stacked-pls',
      'stacked-lead',
      'stacked-employee',
      'stacked-audit',
      'stacked-plan',
      'stacked-swarm',
      'stacked-debug',
      'stacked-tdd',
      'stacked-review',
      'stacked-ship',
      'stacked-deepen',
      'stacked-wizard',
      'stacked-oftb',
      'stacked-loop',
    ];
    assert(skills.length === 16, `expected 16, got ${skills.length}: ${skills.map((s) => s.id).join(', ')}`);
    for (const id of expected) assert(skills.some((s) => s.id === id), `missing skill: ${id}`);
    return skills.map((s) => s.id).join(', ');
  });

  check('skill ids are unique and kebab-case', () => {
    const ids = skills.map((s) => s.id);
    assert(new Set(ids).size === ids.length, `duplicate id: ${ids.join(', ')}`);
    for (const id of ids) assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id), `bad id: ${id}`);
    return `${ids.length} unique`;
  });

  check('every skill has a description the model can route on', () => {
    for (const s of skills) {
      assert(s.description && s.description.length > 20, `${s.id} has no usable description`);
      assert(s.content && s.content.length > 200, `${s.id} body is too thin (${s.content?.length || 0} chars)`);
      assert(fs.existsSync(s.path), `${s.id} path does not exist: ${s.path}`);
    }
    return `shortest body ${Math.min(...skills.map((s) => s.content.length))} chars`;
  });

  check('SOUL.md is registered as stacked-soul, not duplicated', () => {
    const soul = skills.find((s) => s.id === 'stacked-soul');
    assert(soul, 'stacked-soul missing');
    assert(soul.path.endsWith('SOUL.md'), `soul path is ${soul.path}`);
    assert(!fs.existsSync(path.join(repo, 'skills', 'stacked-soul')), 'a duplicate skills/stacked-soul directory exists');
    for (const law of ['Law 1', 'Law 2', 'Law 3', 'Law 4']) assert(soul.content.includes(law), `soul is missing ${law}`);
    return 'four laws present';
  });

  /** The ids the README's skills table advertises, read from that section only. */
  function readmeSkillsTable() {
    const text = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    const start = text.indexOf('## The skills');
    assert(start >= 0, 'README.md has no "The skills" section');
    const rest = text.slice(start + 1);
    const end = rest.search(/\n## /);
    const body = end >= 0 ? rest.slice(0, end) : rest;
    return [...body.matchAll(/^\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|/gm)].map((m) => m[1]);
  }

  check('every skill the docs tell an agent to load is registered', () => {
    const ids = new Set(skills.map((s) => s.id));
    const refs = [];
    const scan = (file) => {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:Load|Read)\s+`([a-z0-9][a-z0-9-]*)`/gi)) {
        refs.push([m[1], path.relative(repo, file)]);
      }
    };
    for (const f of fs.readdirSync(path.join(repo, 'agents'))) {
      if (f.endsWith('.md')) scan(path.join(repo, 'agents', f));
    }
    for (const entry of fs.readdirSync(path.join(repo, 'skills'), { withFileTypes: true })) {
      const file = path.join(repo, 'skills', entry.name, 'SKILL.md');
      if (entry.isDirectory() && fs.existsSync(file)) scan(file);
    }
    assert(refs.length >= 4, `the scan found only ${refs.length} Load/Read references; it is not reading the docs`);
    const missing = refs.filter(([id]) => !ids.has(id));
    assert(!missing.length, `docs load skills that are not registered: ${missing.map(([id, where]) => `${id} (${where})`).join(', ')}`);
    return `${refs.length} references resolve`;
  });

  check('the README skills table and the registry cannot drift', () => {
    const ids = skills.map((s) => s.id);
    const table = readmeSkillsTable();
    const unregistered = table.filter((id) => !ids.includes(id));
    const undocumented = ids.filter((id) => !table.includes(id));
    assert(!unregistered.length, `the README lists skills that are not registered: ${unregistered.join(', ')}`);
    assert(!undocumented.length, `the README omits registered skills: ${undocumented.join(', ')}`);
    assert(new Set(table).size === table.length, `the README lists a skill twice: ${table.join(', ')}`);
    return `${table.length} ids agree`;
  });

  check('the installer advertises the registered skill ids, with prefixes', () => {
    const text = fs.readFileSync(path.join(repo, 'scripts', 'install.mjs'), 'utf8');
    const list = text.match(/skills register:([\s\S]*?)\n\s*3\.\s/);
    assert(list, 'the installer no longer lists the skill ids it registers');
    const advertised = list[1].split(',').map((s) => s.trim()).filter(Boolean);
    const ids = skills.map((s) => s.id);
    const missing = ids.filter((id) => !advertised.includes(id));
    const extra = advertised.filter((id) => !ids.includes(id));
    assert(!missing.length, `the installer omits registered skills: ${missing.join(', ')}`);
    assert(!extra.length, `the installer names ids that are not registered: ${extra.join(', ')}`);
    return `${advertised.length} ids advertised`;
  });

  check('stacked-pls names both exits, and shape comes first', () => {
    const pls = skills.find((s) => s.id === 'stacked-pls');
    assert(pls, 'stacked-pls is not registered');
    const body = pls.content;
    const shape = body.indexOf('## Shape, or execute');
    const execute = body.indexOf('## Execute');
    assert(shape >= 0, 'stacked-pls has no "Shape, or execute" section');
    assert(execute >= 0, 'stacked-pls has no "Execute" section');
    assert(shape < execute, `the shape section must precede the execute section (${shape} vs ${execute})`);
    assert(/\*\*Shape\*\*/.test(body) && /\*\*Execute\*\*/.test(body), 'the two exits are not both named');
    assert(/Default is execute/.test(body), 'the default exit is not stated');
    return 'shape first, execute second';
  });

  check('stacked teaches sharp output, not a separate voice section', () => {
    const stacked = skills.find((s) => s.id === 'stacked');
    assert(stacked, 'stacked is not registered');
    assert(/^## Sharp output$/m.test(stacked.content), 'stacked has no "## Sharp output" section');
    assert(!/^## Voice$/m.test(stacked.content), '"## Voice" still exists as a separate section');
    assert(/Lead with the next action/.test(stacked.content), 'the section does not lead with an action');
    assert(bootstrap().includes('Answer for action'), 'the bootstrap does not carry the action line');
    assert(/five items max/.test(bootstrap()), 'the bootstrap line does not cap the list');
    return 'action contract in skill and bootstrap';
  });

  check('sharp output is an action contract with a pre-send check', () => {
    const stacked = skills.find((s) => s.id === 'stacked').content;
    for (const phrase of ['Lead with the next action', 'Cap visible lists at five', 'No preamble', 'Pre-send check']) {
      assert(stacked.includes(phrase), `stacked is missing "${phrase}"`);
    }
    const soul = fs.readFileSync(path.join(repo, 'SOUL.md'), 'utf8');
    assert(soul.includes('does it need to exist'), 'SOUL.md has no laziness ladder');
    assert(/deletion beats addition/i.test(soul), 'SOUL.md does not say deletion beats addition');
    for (const id of ['stacked-pls', 'stacked-employee']) {
      assert(/what you skipped/.test(skills.find((s) => s.id === id).content), `${id} has no honest tail`);
    }
    const eng = fs.readFileSync(path.join(repo, 'skills', 'stacked-employee', 'references', 'engineering.md'), 'utf8');
    assert(/does it need to exist/i.test(eng), 'the engineering handbook has no ladder');
    return 'ten rules, pre-send check, ladder in SOUL and engineering';
  });

  check('the lead writes savepoints', () => {
    const lead = fs.readFileSync(path.join(repo, 'skills', 'stacked-lead', 'SKILL.md'), 'utf8');
    assert(/^## Savepoints$/m.test(lead), 'stacked-lead has no Savepoints section');
    assert(lead.includes('chore: savepoint'), 'stacked-lead does not name the savepoint commit type');
    assert(!lead.includes('`savepoint:`'), 'stacked-lead still uses savepoint: as a prefix');
    const owner = fs.readFileSync(path.join(repo, 'OWNER.md'), 'utf8');
    assert(/never be allowed to get dirty/.test(owner), 'OWNER.md has no savepoint rule');
    return 'five savepoints, chore: type, owner rule';
  });

  check('the session-title convention is one vocabulary', () => {
    const owner = fs.readFileSync(path.join(repo, 'OWNER.md'), 'utf8');
    for (const status of ['[active]', '[parked]', '[done]']) {
      assert(owner.includes(status), `OWNER.md is missing ${status}`);
    }
    assert(/immutable/.test(owner), 'OWNER.md does not make [done] immutable');
    for (const id of ['stacked-lead', 'stacked-pls']) {
      assert(fs.readFileSync(path.join(repo, 'skills', id, 'SKILL.md'), 'utf8').includes('[done]'), `${id} never sets [done]`);
    }
    return 'three statuses, immutable [done], both skills set it';
  });

  check('the release convention is written down and wired', () => {
    const p = path.join(repo, 'RELEASING.md');
    assert(fs.existsSync(p), 'RELEASING.md is missing');
    const rel = fs.readFileSync(p, 'utf8');
    for (const phrase of ['tag', 'npm view', 'never force-push', 'Conventional Commits', 'imperative']) {
      assert(new RegExp(phrase, 'i').test(rel), `RELEASING.md is missing "${phrase}"`);
    }
    assert(rel.includes('<type>(<scope>): <imperative summary>'), 'RELEASING.md has no commit format');
    const ship = fs.readFileSync(path.join(repo, 'skills', 'stacked-ship', 'SKILL.md'), 'utf8');
    assert(/^## Release$/m.test(ship), 'stacked-ship has no "## Release" section');
    assert(ship.includes('`<type>(<scope>): <imperative summary>`'), 'stacked-ship does not state the commit format');
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    assert(pkg.scripts && pkg.scripts.prepublishOnly, 'package.json has no prepublishOnly: the suite is not the publish gate');
    assert(pkg.private === true, 'package.json is no longer private, so publishing is no longer an owner decision');
    const owner = fs.readFileSync(path.join(repo, 'OWNER.md'), 'utf8');
    assert(/Adopt the upstream format/.test(owner), 'OWNER.md does not adopt the upstream format');
    return 'RELEASING.md, ship, prepublishOnly, owner line';
  });

  check('stacked-pls answers an invocation with no task', () => {
    const pls = skills.find((s) => s.id === 'stacked-pls');
    assert(pls, 'stacked-pls is not registered');
    assert(/^## Invoked bare$/m.test(pls.content), 'stacked-pls has no "## Invoked bare" section');
    assert(pls.content.includes('@stacked-pls'), 'the bare-invocation section does not name @stacked-pls');
    assert(/file:line/.test(pls.content), 'the bare-invocation section does not require file:line evidence');
    return 'bare invocation defined';
  });

  check('bootstrap is cached, marked, and small', () => {
    const a = bootstrap();
    const b = bootstrap();
    assert(a === b, 'bootstrap is rebuilt on every call (cache miss)');
    assert(a.startsWith(MARKER), 'bootstrap does not start with its marker');
    assert(a.includes('</STACKED>'), 'bootstrap has no closing marker');
    assert(a.length < 9000, `bootstrap is ${a.length} chars; it is paid for on every step`);
    assert(a.includes('lead') || a.includes('LEAD'), 'bootstrap does not name the rungs');
    assert(!/\bCEO\b|\bceo\b/.test(a), 'bootstrap still names a CEO seat that no longer exists');
    assert(a.length < 3600, `bootstrap is ${a.length} chars; it is paid for on every step (raised from 3200 when the route table became always-on)`);
    return `${a.length} chars`;
  });

  check('OWNER.md holds the standing decisions', () => {
    const p = path.join(repo, 'OWNER.md');
    assert(fs.existsSync(p), 'OWNER.md is missing');
    const text = fs.readFileSync(p, 'utf8');
    assert(/standing decisions/i.test(text), 'OWNER.md does not say "standing decisions"');
    assert(/source hierarchy/i.test(text), 'OWNER.md does not name the source hierarchy');
    assert(/upstream code and docs at the pinned version/i.test(text), 'OWNER.md has no tier 1');
    assert(/upstream wins until a pinned test says otherwise/i.test(text), 'OWNER.md has no precedence rule');
    assert(/money above the standing cap/i.test(text), 'OWNER.md does not carry the money cap');
    return 'standing decisions, source hierarchy, five stops';
  });

  check('the four autonomy rules are in pls, lead and employee', () => {
    const rules = ['bounded research first', 'carries its source and date', 'names what it looked for', 'routing decision'];
    for (const id of ['stacked-pls', 'stacked-lead', 'stacked-employee']) {
      const text = fs.readFileSync(path.join(repo, 'skills', id, 'SKILL.md'), 'utf8');
      for (const rule of rules) assert(text.toLowerCase().includes(rule), `${id} is missing the rule "${rule}"`);
    }
    for (const id of ['stacked-pls', 'stacked-lead']) {
      assert(/OWNER\.md/.test(fs.readFileSync(path.join(repo, 'skills', id, 'SKILL.md'), 'utf8')), `${id} never names OWNER.md`);
    }
    return 'four rules in three skills, OWNER.md required in pls and lead';
  });

  check('the stop list is five everywhere, and money is in it', () => {
    const boot = bootstrap();
    assert(/\bfive\b/.test(boot), 'the bootstrap does not say five');
    assert(/money/.test(boot), 'the bootstrap omits the money cap');
    assert(!/four things/i.test(boot), 'the bootstrap still says four things');
    const text = (p) => fs.readFileSync(p, 'utf8');
    const walk = (d) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => {
          if (e.name === '.git' || e.name === 'node_modules') return [];
          const p = path.join(d, e.name);
          return e.isDirectory() ? walk(p) : [p];
        })
        .filter((p) => /\.(md|js|mjs)$/.test(p));
    const files = [
      ...walk(path.join(repo, 'agents')),
      ...walk(path.join(repo, 'skills')),
      ...walk(path.join(repo, 'lib')),
      path.join(repo, 'README.md'),
    ];
    const offenders = files.filter((p) => /four things|four stop conditions/i.test(text(p)));
    assert(
      !offenders.length,
      `the stop list is still four in: ${offenders.map((p) => path.relative(repo, p)).join(', ')}`,
    );
    return `bootstrap ${boot.length} chars, five stops, no "four things"`;
  });

  const commandFiles = fs.readdirSync(path.join(repo, 'commands')).filter((f) => f.endsWith('.md'));

  check('four commands exist and are templates, not code', () => {
    assert(commandFiles.length === 4, `expected 4 commands, got ${commandFiles.length}: ${commandFiles.join(', ')}`);
    for (const f of commandFiles) {
      const raw = fs.readFileSync(path.join(repo, 'commands', f), 'utf8');
      assert(/^---\n[\s\S]*?description:/m.test(raw), `${f} has no description`);
      assert(!/^template:/m.test(raw), `${f} puts template in frontmatter`);
      const body = raw.split('---').slice(2).join('---').trim();
      assert(body.length > 80, `${f} body is empty`);
    }
    return commandFiles.length + ' commands';
  });

  check('provenance lives in exactly one file', () => {
    const forbidden = /karpathy|gstack|superpowers|garrytan|obra|multica/i;
    const walk = (d) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => {
          // `.stack/` is working state: a brief may cite a reference
          // implementation to study without that becoming shipped lineage.
          if (e.name === '.git' || e.name === 'node_modules' || e.name === '.stack') return [];
          const p = path.join(d, e.name);
          return e.isDirectory() ? walk(p) : [p];
        });
    const offenders = walk(repo)
      .filter((p) => /\.(md|js|mjs|json)$/.test(p))
      .filter((p) => path.basename(p) !== 'SOURCES.md' && !p.includes('scripts'))
      .filter((p) => forbidden.test(fs.readFileSync(p, 'utf8')))
      .map((p) => path.relative(repo, p));
    assert(offenders.length === 0, `named outside SOURCES.md: ${offenders.join(', ')}`);
    return 'SOURCES.md only';
  });

  check('README points at SOURCES.md for lineage', () => {
    const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    assert(/SOURCES\.md/.test(readme), 'README never mentions where the lineage is recorded');
    return 'pointer present';
  });
}
