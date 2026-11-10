/**
 * Agent files, the roster, and the order the permission rules land in.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function register(ctx) {
  const { check, checkAsync, assert, repo, configuredRepo, runIn } = ctx;

  // ---------------------------------------------------------------- agents, routing, handbooks
  const agentFiles = fs.readdirSync(path.join(repo, 'agents')).filter((f) => f.endsWith('.md'));
  const agentIds = agentFiles.map((f) => f.replace(/\.md$/, '')).sort();
  const archetypes = agentIds.filter((id) => id !== 'lead' && id !== 'auditor');
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

  /** The department handbooks, and exactly which archetypes read each one. */
  const HANDBOOKS = {
    'product.md': ['product-manager', 'project-manager'],
    'design.md': ['ui-designer', 'ux-researcher', 'design-system'],
    'engineering.md': ['frontend', 'backend', 'data-engineer', 'tester'],
    'platform.md': ['devops', 'sre', 'release-manager'],
    'quality.md': ['qa', 'security', 'reviewer', 'design-reviewer'],
    'knowledge.md': ['docs', 'technical-writer', 'data-analyst'],
    'research.md': ['researcher', 'scout', 'fact-checker'],
  };

  check('twenty-four agents exist with valid V2 frontmatter', () => {
    assert(agentFiles.length === 24, `expected 24 agents, got ${agentFiles.length}: ${agentFiles.join(', ')}`);
    for (const id of ['lead', 'auditor', ...Object.values(HANDBOOKS).flat()]) {
      assert(agentIds.includes(id), `missing agent: ${id}.md`);
    }
    const legacy = /\b(tools|temperature|maxSteps|permission)\s*:/;
    for (const f of agentFiles) {
      const raw = fs.readFileSync(path.join(repo, 'agents', f), 'utf8');
      assert(raw.startsWith('---'), `${f} has no frontmatter`);
      const fm = raw.slice(4, raw.indexOf('\n---', 3));
      assert(/^description:/m.test(fm), `${f} has no description`);
      assert(/^mode:/m.test(fm), `${f} has no mode`);
      assert(!legacy.test(fm), `${f} uses a legacy V1 field`);
      const body = raw.split('---').slice(2).join('---');
      assert(body.trim().length > 400, `${f} body is too thin to steer an agent`);
    }
    return `${agentFiles.length} agents`;
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
    return `${agentIds.length} agents use permissions:`;
  });

  check('every non-lead agent ends on a subagent deny', () => {
    const others = agentIds.filter((id) => id !== 'lead');
    for (const id of others) {
      const rules = agentPermissions(id);
      assert(rules.length, `${id}.md has no permission rules`);
      const last = rules[rules.length - 1];
      assert(
        last.action === 'subagent' && last.resource === '*' && last.effect === 'deny',
        `${id}.md ends on ${last.action} ${last.resource} ${last.effect}; a later rule can widen the spawn deny`,
      );
    }
    return `${others.length} agents cannot delegate`;
  });

  check('every non-lead agent puts its edit exceptions after the broad allow', () => {
    const others = agentIds.filter((id) => id !== 'lead');
    for (const id of others) {
      const edits = agentPermissions(id).filter((r) => r.action === 'edit');
      assert(edits.length, `${id}.md has no edit rule`);
      const last = edits[edits.length - 1];
      assert(
        !(last.resource === '*' && last.effect === 'allow'),
        `${id}.md ends its edit rules on * allow, so every exception written above it is dead`,
      );
    }
    return `${others.length} agents end on an exception`;
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

  check('every archetype may edit its own handbook', () => {
    for (const id of archetypes) {
      const entry = Object.entries(HANDBOOKS).find(([, ids]) => ids.includes(id));
      assert(entry, `${id}.md is mapped to no handbook`);
      const [handbook] = entry;
      const edits = agentPermissions(id).filter((r) => r.action === 'edit');
      const last = edits[edits.length - 1];
      assert(
        last && last.effect === 'allow' && last.resource.endsWith(handbook),
        `${id}.md has no edit allow for its own handbook references/${handbook} as its last edit rule; a deny below it would win`,
      );
    }
    return `${archetypes.length} archetypes own one handbook each`;
  });

  check('every archetype puts a shell deny after its broad allow', () => {
    for (const id of archetypes) {
      const shells = agentPermissions(id).filter((r) => r.action === 'shell');
      assert(shells.length, `${id}.md has no shell rule`);
      const last = shells[shells.length - 1];
      assert(
        !(last.resource === '*' && last.effect === 'allow'),
        `${id}.md ends its shell rules on * allow, so every deny written above it is dead`,
      );
    }
    return `${archetypes.length} archetypes end on a shell deny`;
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

  check('the permission sweep covers the roster the agent check asserts', () => {
    assert(agentFiles.length === 24, `the roster is ${agentFiles.length} agents, not 24; change the roster assertion and this sweep together`);
    const swept = agentFiles.filter((f) => {
      const raw = fs.readFileSync(path.join(repo, 'agents', f), 'utf8');
      return /^permissions:/m.test(raw.slice(4, raw.indexOf('\n---', 3)));
    }).length;
    assert(swept === agentFiles.length, `the permission sweep reads ${swept} of ${agentFiles.length} agents`);
    return `${swept} of 24 agents carry permissions:`;
  });

  check('every archetype is a subagent that denies subagent and reads one handbook', () => {
    for (const id of archetypes) {
      const raw = fs.readFileSync(path.join(repo, 'agents', `${id}.md`), 'utf8');
      assert(/^mode:\s*subagent$/m.test(raw), `${id}.md is not mode: subagent`);
      assert(/action:\s*subagent[\s\S]{0,160}effect:\s*deny/.test(raw), `${id}.md does not deny the subagent action`);
      const body = raw.split('---').slice(2).join('---').trim();
      const lines = body.split('\n').length;
      assert(lines <= 30, `${id}.md body is ${lines} lines; the cap is 30`);
      assert(lines >= 18, `${id}.md body is ${lines} lines; too thin to steer`);
      assert(/Load `stacked-employee`/.test(body), `${id}.md does not load stacked-employee`);
      assert(/stacked-soul/.test(body), `${id}.md does not load stacked-soul`);
      const named = Object.keys(HANDBOOKS).filter((h) => body.includes(`references\\${h}`) || body.includes(`references/${h}`));
      assert(named.length === 1, `${id}.md names ${named.length} handbooks (${named.join(', ')}); it reads exactly one`);
    }
    return `${archetypes.length} archetypes cannot delegate`;
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

  check('routing.json covers every agent exactly once, and the lead inherits', () => {
    const ids = Object.keys(routing).filter((key) => key !== '_comment').sort();
    assert(ids.length === 24, `routing.json has ${ids.length} ids, expected 24`);
    for (const id of agentIds) assert(ids.includes(id), `routing.json has no entry for ${id}`);
    assert(routing.lead === null, `lead is ${JSON.stringify(routing.lead)}, expected null`);

    const tier = { terra: [], muse: [], deepseek: [] };
    for (const id of ids) {
      const model = routing[id];
      if (model === null) continue;
      if (model === TERRA) tier.terra.push(id);
      else if (model === MUSE) tier.muse.push(id);
      else if (model === DEEPSEEK) tier.deepseek.push(id);
      else throw new Error(`routing.json names an unknown model for ${id}: ${model}`);
    }
    const expectTerra = ['auditor', 'product-manager', 'design-reviewer', 'qa', 'security', 'reviewer', 'researcher', 'scout', 'fact-checker'];
    const expectDeepseek = ['frontend', 'backend', 'data-engineer', 'tester'];
    const expectMuse = [
      'project-manager', 'ui-designer', 'ux-researcher', 'design-system', 'devops',
      'sre', 'release-manager', 'docs', 'technical-writer', 'data-analyst',
    ];
    for (const id of expectTerra) assert(routing[id] === TERRA, `${id} should be terra, is ${routing[id]}`);
    for (const id of expectDeepseek) assert(routing[id] === DEEPSEEK, `${id} should be deepseek, is ${routing[id]}`);
    for (const id of expectMuse) assert(routing[id] === MUSE, `${id} should be muse, is ${routing[id]}`);
    return `terra ${tier.terra.length} · muse ${tier.muse.length} · deepseek ${tier.deepseek.length} · lead inherit`;
  });

  check('every archetype reads a handbook that exists and is long enough', () => {
    const dir = path.join(repo, 'skills', 'stacked-employee', 'references');
    for (const [file, ids] of Object.entries(HANDBOOKS)) {
      const p = path.join(dir, file);
      assert(fs.existsSync(p), `handbook missing: references/${file}`);
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n').length;
      assert(lines > 60, `references/${file} is ${lines} lines; the floor is 60`);
      for (const id of ids) {
        const body = fs.readFileSync(path.join(repo, 'agents', `${id}.md`), 'utf8');
        assert(
          body.includes(`references\\${file}`) || body.includes(`references/${file}`),
          `${id}.md does not name its handbook references/${file}`,
        );
      }
    }
    const mapped = Object.values(HANDBOOKS).flat().sort();
    const gap = archetypes.filter((id) => !mapped.includes(id));
    const extra = mapped.filter((id) => !archetypes.includes(id));
    assert(!gap.length, `archetypes with no handbook: ${gap.join(', ')}`);
    assert(!extra.length, `handbooks claim archetypes that do not exist: ${extra.join(', ')}`);
    return `${Object.keys(HANDBOOKS).length} handbooks cover ${mapped.length} archetypes`;
  });

  check('the generic seat and the folded archetypes are gone', () => {
    for (const gone of ['employee', 'refactorer', 'debugger', 'builder']) {
      assert(!fs.existsSync(path.join(repo, 'agents', `${gone}.md`)), `agents/${gone}.md is back`);
    }
    return 'employee, refactorer and debugger are not files';
  });

  check('stacked-lead routes every archetype, and research comes first', () => {
    const lead = fs.readFileSync(path.join(repo, 'skills', 'stacked-lead', 'SKILL.md'), 'utf8');
    assert(/^## Routing$/m.test(lead), 'stacked-lead has no Routing section');
    const rows = [...lead.matchAll(/^\|[^|\n]*\|\s*`([a-z0-9-]+)`\s*\|$/gm)].map((m) => m[1]);
    const missing = archetypes.filter((id) => !rows.includes(id));
    assert(!missing.length, `stacked-lead has no routing row for: ${missing.join(', ')}`);
    assert(rows.length === archetypes.length, `routing table has ${rows.length} rows for ${archetypes.length} archetypes`);
    assert(/`researcher` or `scout` before it is briefed/.test(lead), 'the routing section does not put research before the brief');
    return `${rows.length} rows, one per archetype`;
  });

  await checkAsync('a dispatch block names the archetype, its routed model, or unassigned', async () => {
    const d = configuredRepo();
    const assigned = await runIn(d, 'brief', {
      op: 'new',
      agent: 'qa',
      title: 'named seat',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['n.md'],
    });
    assert(/Agent: qa \(openai\/gpt-6\.1-terra\)/.test(assigned), `the block did not name the archetype and model:\n${assigned}`);

    const unassigned = await runIn(d, 'brief', {
      op: 'new',
      title: 'no seat',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['m.md'],
    });
    assert(/Agent: unassigned/.test(unassigned), `a seam with no archetype did not print unassigned:\n${unassigned}`);

    const gate = await runIn(d, 'ready', { id: 'no-seat', lean: true });
    assert(/NO-GO/.test(gate), `a seam with no archetype was gated GO:\n${gate}`);
    assert(/archetype/i.test(gate), `the missing archetype was not named:\n${gate}`);

    const bogus = await runIn(d, 'brief', {
      op: 'new',
      agent: 'wizard',
      title: 'bogus seat',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['o.md'],
    });
    assert(/Refused/.test(bogus), 'an archetype absent from routing.json was accepted');
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
