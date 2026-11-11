/**
 * The six seat files, the order their permission rules land in, the routing
 * table, and the role cards the seats read.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bootstrap } from '../../lib/bootstrap.js';

/** The two seats: a permission boundary and a model, never a personality. */
const SEATS = ['lead', 'morph'];
/** The three model tiers a role card may name: workhorse codes and tests, thinker reasons and verifies, generalist covers the rest. */
const TIERS = ['workhorse', 'thinker', 'generalist'];
/** The morph seat returns diffs, so no seat in this roster is read-only. */
const READ_ONLY = [];
/** The seven departments a role card may name. */
const DEPARTMENTS = ['engineering', 'quality', 'platform', 'design', 'knowledge', 'product', 'research'];
/** A card's body, in this order, and nothing else. */
const CARD_HEADINGS = ['Owns', 'Must not', 'Proof', 'Handoff'];
/** A card's frontmatter keys, exactly. */
const CARD_KEYS = ['name', 'title', 'department', 'seat', 'tier', 'proof'];
/** The cap a card is held to, in characters. */
const CARD_CAP = 1300;
/**
 * The archetype agents the six seats replaced. A stale agent is still a
 * description the model can pick, so their absence is asserted, not assumed.
 */
const RETIRED = [
  'backend',
  'data-analyst',
  'data-engineer',
  'design-reviewer',
  'design-system',
  'devops',
  'docs',
  'fact-checker',
  'frontend',
  'product-manager',
  'project-manager',
  'qa',
  'release-manager',
  'researcher',
  'reviewer',
  'security',
  'sre',
  'technical-writer',
  'tester',
  'ui-designer',
  'ux-researcher',
];

export async function register(ctx) {
  const { check, checkAsync, assert, repo, configuredRepo, runIn } = ctx;

  // ------------------------------------------------------ seats, permissions, routing
  const agentFiles = fs.readdirSync(path.join(repo, 'agents')).filter((f) => f.endsWith('.md'));
  const agentIds = agentFiles.map((f) => f.replace(/\.md$/, '')).sort();
  const routing = JSON.parse(fs.readFileSync(path.join(repo, 'routing.json'), 'utf8'));

  /** An agent's `permissions` rules from its frontmatter, in file order. */
  function agentPermissions(id) {
    const raw = fs.readFileSync(path.join(repo, 'agents', `${id}.md`), 'utf8');
    const frontmatter = raw.slice(4, raw.indexOf('\n---', 3));
    const rule = /^[ \t]*-[ \t]+action:[ \t]*(.+?)[ \t]*\r?\n[ \t]+resource:[ \t]*(.+?)[ \t]*\r?\n[ \t]+effect:[ \t]*(.+?)[ \t]*$/gm;
    const unquote = (value) => value.replace(/^"(.*)"$/, '$1');
    return [...frontmatter.matchAll(rule)].map((m) => ({
      action: unquote(m[1]),
      resource: unquote(m[2]),
      effect: unquote(m[3]),
    }));
  }

  const TERRA = 'openai/gpt-6.1-terra';
  const MUSE = 'opencode-go/muse-spark-1.3-contributor';
  const DEEPSEEK = 'opencode-go/deepseek-v4.1-flash';

  check('two seats exist with valid V2 frontmatter', () => {
    assert(agentFiles.length === SEATS.length, `expected ${SEATS.length} seats, got ${agentFiles.length}: ${agentFiles.join(', ')}`);
    assert(
      agentIds.join(',') === [...SEATS].sort().join(','),
      `the seat ids are ${agentIds.join(', ')}; expected exactly ${[...SEATS].sort().join(', ')}`,
    );
    const legacy = /\b(tools|temperature|maxSteps|permission)\s*:/;
    for (const f of agentFiles) {
      const raw = fs.readFileSync(path.join(repo, 'agents', f), 'utf8');
      assert(raw.startsWith('---'), `${f} has no frontmatter`);
      const fm = raw.slice(4, raw.indexOf('\n---', 3));
      assert(/^description:/m.test(fm), `${f} has no description`);
      assert(/^mode:/m.test(fm), `${f} has no mode`);
      assert(!legacy.test(fm), `${f} uses a legacy V1 field`);
      const body = raw.split('---').slice(2).join('---');
      assert(body.trim().length > 400, `${f} body is too thin to steer an agent (${body.trim().length} chars)`);
    }
    return `${agentFiles.length} seats: ${agentIds.join(', ')}`;
  });

  check('the lead edits only .stack, and the exception comes after the ask', () => {
    const rules = agentPermissions('lead');
    const ask = rules.findIndex((r) => r.action === 'edit' && r.resource === '*' && r.effect === 'ask');
    const tree = rules.findIndex((r) => r.action === 'edit' && r.resource === '**/.stack/**' && r.effect === 'allow');
    const root = rules.findIndex((r) => r.action === 'edit' && r.resource === '**/.stack' && r.effect === 'allow');
    assert(ask >= 0, 'lead.md has no broad edit ask rule');
    assert(tree >= 0, 'lead.md has no **/.stack/** edit allow rule');
    assert(root >= 0, 'lead.md has no **/.stack edit allow rule');
    assert(Math.min(tree, root) > ask, 'the .stack allow rules come before the broad ask; last match wins, so they never apply');
    return 'ask, then **/.stack and **/.stack/**';
  });

  check('no agent uses the legacy singular permission key', () => {
    const offenders = agentIds.filter((id) => {
      const raw = fs.readFileSync(path.join(repo, 'agents', `${id}.md`), 'utf8');
      return /^permission[ \t]*:/m.test(raw.slice(4, raw.indexOf('\n---', 3)));
    });
    assert(!offenders.length, `the legacy singular permission: key is in: ${offenders.join(', ')}`);
    return `${agentIds.length} seats use permissions:`;
  });

  check('every non-lead seat is a subagent that cannot dispatch another agent', () => {
    const others = SEATS.filter((id) => id !== 'lead');
    for (const id of others) {
      const raw = fs.readFileSync(path.join(repo, 'agents', `${id}.md`), 'utf8');
      assert(/^mode:\s*subagent$/m.test(raw), `${id}.md is not mode: subagent`);
      const rules = agentPermissions(id).filter((r) => r.action === 'subagent');
      assert(rules.length, `${id}.md has no subagent rule`);
      const last = rules[rules.length - 1];
      assert(
        last.effect === 'deny',
        `${id}.md ends its subagent rules on ${last.effect} ${last.resource}; a later rule would widen the spawn deny`,
      );
    }
    return `${others.length} seats cannot delegate`;
  });

  check('a direct morph denies all actions unless explicitly safe', () => {
    const rules = agentPermissions('morph');
    const broad = rules.findIndex((r) => r.action === '*' && r.resource === '*' && r.effect === 'deny');
    assert(broad >= 0, 'morph has no default deny for direct children');
    for (const action of ['edit', 'shell', 'subagent']) {
      const matching = rules.filter((r) => (r.action === '*' || r.action === action) && r.resource === '*');
      assert(matching.at(-1)?.effect === 'deny', `direct morph permits ${action}`);
    }
    assert(!rules.some((r, i) => i > broad && r.effect === 'allow' && (r.action === '*' || r.action === 'edit' || r.action === 'shell')), 'direct morph widens its default deny');
    assert(bootstrap().includes('stack.dispatch'), 'bootstrap does not route dispatch through the guard');
    return 'unconfigured morph denies edit, shell, subagents and unknown actions';
  });

  check('each seat ends its edit rules on the boundary its work needs', () => {
    for (const id of READ_ONLY) {
      const edits = agentPermissions(id).filter((r) => r.action === 'edit');
      assert(edits.length, `${id}.md has no edit rule`);
      const last = edits[edits.length - 1];
      assert(
        last.effect === 'deny',
        `${id}.md ends its edit rules on ${last.effect} ${last.resource}; a read-only seat returns words, not diffs`,
      );
    }
    const edits = agentPermissions('morph').filter((r) => r.action === 'edit');
    assert(edits.length, 'morph.md has no edit rule');
    const last = edits[edits.length - 1];
    assert(
      last.effect === 'deny',
      `morph.md ends its edit rules on ${last.effect} ${last.resource}; direct morph must deny edits`,
    );
    return `${READ_ONLY.length} read-only seats deny, direct morph denies`;
  });

  check('every edit deny names a path the engine can actually send', () => {
    let denies = 0;
    for (const id of agentIds) {
      for (const rule of agentPermissions(id)) {
        if (rule.action !== 'edit' || rule.effect !== 'deny') continue;
        denies += 1;
        assert(
          rule.resource === '*' || rule.resource.startsWith('**/'),
          `${id}.md denies edit to "${rule.resource}" with no **/ prefix; edit resources are absolute, so it never matches`,
        );
      }
    }
    assert(denies > 0, 'no edit deny rule was found; the sweep is not reading the rules');
    return `${denies} denies anchored`;
  });

  check('every shell deny is bounded by a wildcard on both sides', () => {
    let denies = 0;
    for (const id of agentIds) {
      for (const rule of agentPermissions(id)) {
        if (rule.action !== 'shell' || rule.effect !== 'deny') continue;
        denies += 1;
        assert(
          rule.resource.startsWith('*') && rule.resource.endsWith('*'),
          `${id}.md denies shell "${rule.resource}"; the matcher anchors the pattern, so it only catches a command that starts or ends with it`,
        );
      }
    }
    assert(denies > 0, 'no shell deny rule was found; the sweep is not reading the rules');
    return `${denies} denies bounded on both sides`;
  });

  check('the permission sweep covers the roster the seat check asserts', () => {
    assert(
      agentFiles.length === SEATS.length,
      `the roster is ${agentFiles.length} agents, not ${SEATS.length}; change the roster assertion and this sweep together`,
    );
    const swept = agentFiles.filter((f) => {
      const raw = fs.readFileSync(path.join(repo, 'agents', f), 'utf8');
      return /^permissions:/m.test(raw.slice(4, raw.indexOf('\n---', 3)));
    }).length;
    assert(swept === agentFiles.length, `the permission sweep reads ${swept} of ${agentFiles.length} seats`);
    return `${swept} of ${SEATS.length} seats carry permissions:`;
  });

  check('no shipped agent carries a model line', () => {
    for (const f of agentFiles) {
      assert(
        !/^model:/m.test(fs.readFileSync(path.join(repo, 'agents', f), 'utf8')),
        `${f} ships a model: line; routing belongs in routing.json and is applied at install`,
      );
    }
    return 'unpinned in the repository';
  });

  check('routing.json carries the two seats, both inheriting, plus the three model tiers', () => {
    const table = routing;
    const ids = Object.keys(table)
      .filter((key) => !['_comment', 'tiers', 'complexity', 'readOnlyRoles', 'fallbacks'].includes(key))
      .sort();
    assert(ids.join(',') === [...SEATS].sort().join(','), `routing.json has ${ids.length} seat ids (${ids.join(', ')}), expected exactly the two seats (${[...SEATS].sort().join(', ')})`);
    assert(table.lead === null, `lead is ${JSON.stringify(table.lead)}, expected null`);
    assert(table.morph === null, `morph is ${JSON.stringify(table.morph)}, expected null`);

    const tiers = table.tiers && typeof table.tiers === 'object' ? table.tiers : null;
    assert(tiers, 'routing.json has no tiers table');
    const EXPECT = new Map(TIERS.map((id) => [id, tiers[id]]));
    const tierIds = Object.keys(tiers).sort();
    assert(tierIds.join(',') === [...EXPECT.keys()].sort().join(','), `tiers are ${tierIds.join(', ')}, expected ${[...EXPECT.keys()].sort().join(', ')}`);
    for (const [id, model] of EXPECT) {
      assert(typeof model === 'string' && /^[^/\s]+\/[^/\s]+$/.test(model), `${id} must name a provider/model`);
    }
    const pinnedRoles = RETIRED.filter((id) => Object.prototype.hasOwnProperty.call(routing, id));
    assert(
      !pinnedRoles.length,
      `routing.json pins ${pinnedRoles.length} role card(s) as if they were seats: ${pinnedRoles.join(', ')}; a card is read by a seat and never gets a model pin`,
    );
    return `workhorse deepseek · thinker terra · generalist muse · lead, morph inherit`;
  });

  check('stacked-lead routes the two seats, and picks a card by department', () => {
    const skillDir = path.join(repo, 'skills', 'stacked-lead');
    const text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const start = text.search(/^## Routing$/m);
    assert(start >= 0, 'stacked-lead has no Routing section');
    const rest = text.slice(start + 1);
    const next = rest.search(/\n## /);
    const section = next >= 0 ? rest.slice(0, next) : rest;

    // One table row per seat: the first cell of the row is the seat id.
    const rows = section
      .split('\n')
      .map((line) => /^\|\s*`([a-z0-9-]+)`\s*\|/.exec(line))
      .filter(Boolean)
      .map((m) => m[1]);
    assert(
      rows.length === SEATS.length,
      `the routing table has ${rows.length} seat row(s) (${rows.join(', ') || 'none'}); expected exactly one per seat (${SEATS.join(', ')})`,
    );
    const missing = SEATS.filter((seat) => !rows.includes(seat));
    assert(!missing.length, `stacked-lead has no routing row for: ${missing.join(', ')}`);
    const extra = rows.filter((id) => !SEATS.includes(id));
    assert(!extra.length, `stacked-lead routes ids that are not seats: ${extra.join(', ')}; the 22 roles are cards, not seats`);

    // The cards are the list: a router that enumerates every role is a table
    // that rots, so the table names where they live and how one is chosen.
    assert(/roles\//.test(section), 'the Routing section never names roles/; the cards are the list');
    assert(/department/i.test(section), 'the Routing section does not say a card is chosen by its department');

    // The rule survives the collapse: research comes before the brief. The
    // router may carry it in SKILL.md or in a reference the router names.
    const references = fs.existsSync(path.join(skillDir, 'references'))
      ? fs.readdirSync(path.join(skillDir, 'references')).filter((f) => f.endsWith('.md')).sort()
      : [];
    const scanned = [path.join(skillDir, 'SKILL.md'), ...references.map((f) => path.join(skillDir, 'references', f))];
    const researchFirst = scanned.some((file) =>
      /`researcher` or `scout` before it is briefed/.test(fs.readFileSync(file, 'utf8')),
    );
    assert(
      researchFirst,
      `stacked-lead does not put research before the brief in ${scanned.map((f) => path.relative(repo, f)).join(', ')}`,
    );
    return `${rows.length} seat rows, roles/ by department, research first`;
  });

  check('the retired archetype agents are gone, not shadowed', () => {
    const back = RETIRED.filter((id) => fs.existsSync(path.join(repo, 'agents', `${id}.md`)));
    assert(!back.length, `agents/ still ships ${back.length} retired archetype(s): ${back.join(', ')}; a stale agent is a description the model can still pick`);
    return `${RETIRED.length} retired agents absent`;
  });

  check('installer names all five retired seats and docs warn of retirement', () => {
    const installer = fs.readFileSync(path.join(repo, 'scripts', 'install.mjs'), 'utf8');
    const docs = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
    for (const id of ['employee', 'auditor', 'scout', 'runner', 'planner']) {
      assert(installer.includes(`'${id}.md'`), `installer omits ${id}`);
      assert(docs.includes(`\`${id}\``), `README omits ${id}`);
    }
    assert(/retire.*on install/i.test(docs), 'README does not warn seats retire on install');
    return 'five legacy seats named in installer and install warning';
  });

  // ---------------------------------------------------------------- role cards
  const rolesDir = path.join(repo, 'roles');
  const cardFiles = fs.existsSync(rolesDir) ? fs.readdirSync(rolesDir).filter((f) => f.endsWith('.md')).sort() : [];

  /** A card's frontmatter fields and its body, or null when it has no frontmatter. */
  function cardOf(raw) {
    if (!raw.startsWith('---')) return null;
    const end = raw.indexOf('\n---', 3);
    if (end < 0) return null;
    const fields = {};
    for (const line of raw.slice(4, end).split('\n')) {
      const m = /^([a-z][a-z-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
      if (m) fields[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
    }
    return { fields, body: raw.slice(end + 4) };
  }

  /** Every fault in one card, as a sentence; an empty list is a valid card. */
  function cardFaults(file, raw) {
    const card = cardOf(raw);
    if (!card) return [`${file} has no frontmatter`];
    const { fields, body } = card;
    const faults = [];
    const extra = Object.keys(fields).filter((key) => !CARD_KEYS.includes(key));
    if (extra.length) faults.push(`${file} has frontmatter keys beyond ${CARD_KEYS.join(', ')}: ${extra.join(', ')}`);
    for (const key of CARD_KEYS) if (!fields[key]) faults.push(`${file} has no ${key}`);
    if (fields.department && !DEPARTMENTS.includes(fields.department)) {
      faults.push(`${file} department "${fields.department}" is not one of the seven (${DEPARTMENTS.join(', ')})`);
    }
    if (fields.seat && !SEATS.includes(fields.seat)) {
      faults.push(`${file} seat "${fields.seat}" is not one of the two seats (${SEATS.join(', ')})`);
    }
    if (fields.tier && !TIERS.includes(fields.tier)) {
      faults.push(`${file} tier "${fields.tier}" is not one of the three tiers (${TIERS.join(', ')})`);
    }
    const headings = [...body.matchAll(/^##[ \t]+(.+?)[ \t\r]*$/gm)].map((m) => m[1]);
    if (headings.join('|') !== CARD_HEADINGS.join('|')) {
      faults.push(
        `${file} body headings are ${headings.join(', ') || 'none'}; expected exactly ${CARD_HEADINGS.join(', ')} in that order`,
      );
    }
    if (raw.length > CARD_CAP) faults.push(`${file} is ${raw.length} characters; the cap is ${CARD_CAP}`);
    return faults;
  }

  /** A minimal valid card, for the two cases that need a fixture of their own. */
  const sampleCard = (seat, department, tier = 'workhorse') =>
    `---\nname: Sample\ntitle: Senior Sample\ndepartment: ${department}\nseat: ${seat}\ntier: ${tier}\nproof: node -e "process.exit(0)"\n---\n\n` +
    `## Owns\none decision\n\n## Must not\none failure\n\n## Proof\none command\n\n## Handoff\none paragraph\n`;

  check('the role cards carry a seat, a tier, a department and the four sections', () => {
    assert(
      cardFiles.length === 22,
      `expected 22 role cards in roles/, got ${cardFiles.length}: ${cardFiles.join(', ') || 'none'}`,
    );
    const cards = cardFiles.map((f) => [f, fs.readFileSync(path.join(rolesDir, f), 'utf8')]);
    const faults = cards.flatMap(([f, raw]) => cardFaults(f, raw));
    for (const [file, raw] of cards) assert(/^Senior\s+\S/.test(cardOf(raw).fields.title || ''), `${file} has no exported senior expertise title`);
    assert(!faults.length, faults.join('\n        '));
    const counts = SEATS.map((seat) => `${seat} ${cards.filter(([, raw]) => cardOf(raw).fields.seat === seat).length}`);
    return `${cardFiles.length} cards (${counts.join(' · ')})`;
  });

  check('a card naming an unknown seat or tier fails, cards stay optional per seat', () => {
    const bogus = cardFaults('ghost.md', sampleCard('wizard', 'engineering'));
    assert(
      bogus.some((f) => /seat "wizard"/.test(f)),
      `an unknown seat was accepted: ${bogus.join('; ') || 'no fault found'}`,
    );
    const bogusTier = cardFaults('ghost-tier.md', sampleCard('morph', 'engineering', 'ultraviolet'));
    assert(
      bogusTier.some((f) => /tier "ultraviolet"/.test(f)),
      `an unknown tier was accepted: ${bogusTier.join('; ') || 'no fault found'}`,
    );

    // Cards are optional per seat and department: a deck may carry one morph
    // engineering card and no lead card at all. Only the two seat files are mandatory.
    const deck = [
      ['one-morph.md', sampleCard('morph', 'engineering', 'workhorse')],
      ['two-morph.md', sampleCard('morph', 'quality', 'thinker')],
    ];
    const faults = deck.flatMap(([f, raw]) => cardFaults(f, raw));
    assert(!faults.length, `a deck with no card for one seat was refused: ${faults.join('; ')}`);
    return 'unknown seat and tier refused, cards optional per seat';
  });

  await checkAsync('a dispatch block names the seat, its tier model, or unassigned', async () => {
    const d = configuredRepo();
    const assigned = await runIn(d, 'brief', {
      op: 'new',
      agent: 'morph',
      title: 'named seat',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['n.md'],
    });
    assert(/Agent: morph \(inherit\)/.test(assigned), `the block did not name the seat and model:\n${assigned}`);
    assert(/Model tiers \(routing\.json\):/.test(assigned), `the block did not name the tier table:\n${assigned}`);
    assert(/workhorse → /.test(assigned), `the block did not name the workhorse tier:\n${assigned}`);

    const unassigned = await runIn(d, 'brief', {
      op: 'new',
      title: 'no seat',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['m.md'],
    });
    assert(/Agent: unassigned/.test(unassigned), `a seam with no seat did not print unassigned:\n${unassigned}`);

    const gate = await runIn(d, 'ready', { id: 'no-seat', lean: true });
    assert(/NO-GO/.test(gate), `a seam with no seat was gated GO:\n${gate}`);
    assert(/archetype/i.test(gate), `the missing seat was not named:\n${gate}`);

    const bogus = await runIn(d, 'brief', {
      op: 'new',
      agent: 'wizard',
      title: 'bogus seat',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['o.md'],
    });
    assert(/Refused/.test(bogus), 'a seat absent from routing.json was accepted');
    assert(!fs.existsSync(path.join(d, '.stack', 'briefs', 'bogus-seat.md')), 'the refused brief was still written');

    fs.rmSync(d, { recursive: true, force: true });
    return 'named, unassigned, refused at the gate';
  });

  check('the removed CEO seat is gone, not shadowed', () => {
    assert(!fs.existsSync(path.join(repo, 'agents', 'ceo.md')), 'agents/ceo.md is back');
    assert(!fs.existsSync(path.join(repo, 'skills', 'stacked-ceo')), 'skills/stacked-ceo/ is back');
    // Two files must name the deletion: the cleanup list in the installer, and
    // this guard. Every other reference is a ghost seat.
    const allowed = new Set(['scripts/check/agents.mjs', 'scripts/install.mjs']);
    const offenders = [];
    const walk = (d) =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => {
          if (e.name === '.git' || e.name === 'node_modules') return [];
          const p = path.join(d, e.name);
          return e.isDirectory() ? walk(p) : [p];
        });
    for (const file of walk(repo)) {
      const where = path.relative(repo, file).replace(/\\/g, '/');
      if (allowed.has(where)) continue;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (/stacked-ceo/.test(text) || /agents[\\/]ceo\.md/.test(text)) offenders.push(where);
    }
    assert(!offenders.length, `the deleted CEO seat is still referenced in: ${offenders.join(', ')}`);
    return 'no ghost seat';
  });
}
