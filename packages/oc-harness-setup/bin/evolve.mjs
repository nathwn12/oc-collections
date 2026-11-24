/**
 * Standalone evolve engine. The CLI supplies every I/O seam; this module never
 * imports bin/cli.js and never parses JSONC. One factory, one returned runner.
 */
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const KINDS = ['skill', 'command', 'agent', 'playbook'];
const ID_RE = /^[a-z][a-z0-9-]*$/;
const TOKEN_RE = /\{\{[^{}]*\}\}/;
const TODO_BODY = 'TODO: add the procedure.';

const fail = (log, message, code = 1) => {
  log(`evolve: ${message}`);
  return code;
};

const render = (template, vars) => {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(String(value));
  }
  return out;
};

const bodyText = (body, readText) => {
  if (body === undefined || body === null) return TODO_BODY;
  if (body === '-') {
    try {
      return readFileSync(0, 'utf8');
    } catch (error) {
      throw new Error(`cannot read stdin: ${error.message}`);
    }
  }
  if (typeof body !== 'string') throw new Error('body must be a path, "-", or omitted');
  try {
    return readText(body);
  } catch (error) {
    throw new Error(`cannot read body file ${body}: ${error.message}`);
  }
};

/* A missing frontmatter block is valid (playbooks carry none). An opened but
 * unterminated one, an unquoted ': ' value, or a name/id mismatch is not. */
function frontmatterError(text, kind, id) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return 'unterminated frontmatter';
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const quoted = /^".*"$/.test(value) || /^'.*'$/.test(value);
    if (!quoted && value.includes(': ')) return `unquoted ': ' scalar in ${key}`;
    if (kind === 'skill' && key === 'name' && value !== id) {
      return `skill name ${value} does not match id ${id}`;
    }
  }
  return null;
}

/* Every plain object, string-aware, at any nesting depth. A stack of opening
 * braces keeps the walk generic: a permission entry under `permissions` is
 * found the same way as any other nested object, with no path special case. */
function scanObjects(text) {
  const objects = [];
  const starts = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') starts.push(i);
    else if (c === '}' && starts.length) {
      const start = starts.pop();
      objects.push({ start, end: i + 1, text: text.slice(start, i + 1) });
    }
  }
  return objects;
}

const field = (object, name) => new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(object.text)?.[1];

const isSkillAllow = (object) =>
  field(object, 'action') === 'skill' && field(object, 'effect') === 'allow';

/* Insert after the last shipped skill allow, matching its exact shape. No
 * duplicate when the id is already allowed. */
function amendConfig(text, id) {
  const allows = scanObjects(text).filter(isSkillAllow);
  if (allows.some((object) => field(object, 'resource') === id)) return text;

  if (allows.length) {
    const last = allows[allows.length - 1];
    const lineStart = text.lastIndexOf('\n', last.start - 1) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lineStart, last.start))?.[0] || '    ';
    const trailing = /^\s*,/.exec(text.slice(last.end))?.[0];
    const insertAt = trailing ? last.end + trailing.length : last.end;
    const block = [
      trailing ? '' : ',',
      '\n',
      `${indent}{`,
      `${indent}  "action": "skill",`,
      `${indent}  "resource": "${id}",`,
      `${indent}  "effect": "allow"`,
      `${indent}}${trailing ? ',' : ''}`,
    ].join('');
    return text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  const match = /"permissions"\s*:\s*\[/.exec(text);
  if (!match) throw new Error('opencode.jsonc has no permissions array');
  let inString = false;
  let escaped = false;
  let depth = 0;
  let close = -1;
  for (let i = match.index + match[0].length - 1; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) throw new Error('unterminated permissions array');
  const open = match.index + match[0].length - 1;
  const lineStart = text.lastIndexOf('\n', close - 1) + 1;
  const before = text.slice(0, lineStart).replace(/[ \t\r\n]+$/, '');
  const content = text.slice(open + 1, lineStart).trim();
  const needsComma = content.length > 0 && !content.endsWith(',');
  const indent = '    ';
  const block = [
    needsComma ? ',' : '',
    `\n${indent}{`,
    `${indent}  "action": "skill",`,
    `${indent}  "resource": "${id}",`,
    `${indent}  "effect": "allow"`,
    `${indent}}`,
  ].join('');
  return before + block + '\n' + text.slice(lineStart);
}

/* Plain path cell, appended at the end of the existing match table. */
function amendRouter(text, id, phrase) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => line.includes(`playbooks/${id}.md`))) return text;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i])) last = i;
  }
  if (last === -1) throw new Error('playbook router has no match table');
  lines.splice(last + 1, 0, `| ${phrase} | playbooks/${id}.md |`);
  return lines.join(nl);
}

/**
 * @param {object} deps
 * @param {string} deps.pkgRoot package root holding templates/<kind>.md
 * @param {string} deps.configDir config root to write into and doctor
 * @param {(dir: string) => Promise<number>} deps.runDoctor
 * @param {(p: string) => string} deps.readText throws when missing
 * @param {(p: string, text: string) => void} deps.writeText atomic write
 * @param {(line: string) => void} deps.log
 * @returns {(options: object) => Promise<number>}
 */
export function createEvolve({ pkgRoot, configDir, runDoctor, readText, writeText, log }) {
  const emit = typeof log === 'function' ? log : () => {};
  const abs = (...parts) => path.join(configDir, ...parts);
  const tryRead = (p) => {
    try { return readText(p); } catch { return null; }
  };

  return async function evolve(options = {}) {
    const {
      kind, id, title, description, body, dryRun = false, force = false,
    } = options;

    if (!KINDS.includes(kind)) {
      return fail(emit, `invalid kind '${kind}'; valid kinds: ${KINDS.join(', ')}`, 2);
    }
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      return fail(emit, `invalid id '${id}'; expected ${ID_RE}`, 2);
    }
    if (typeof title !== 'string' || !title.trim()) return fail(emit, 'title is required');
    if (typeof description !== 'string' || !description.trim()) {
      return fail(emit, 'description is required');
    }

    const targets = [];
    if (kind === 'skill') {
      targets.push({ path: abs('skills', id, 'SKILL.md'), template: 'skill.md' });
      targets.push({ path: abs('commands', `${id}.md`), template: 'command.md' });
    } else if (kind === 'command') {
      targets.push({ path: abs('commands', `${id}.md`), template: 'command.md' });
    } else if (kind === 'agent') {
      targets.push({ path: abs('agents', `${id}.md`), template: 'agent.md' });
    } else {
      targets.push({ path: abs('playbooks', `${id}.md`), template: 'playbook.md' });
    }

    const amendments = [];
    if (kind === 'skill') {
      amendments.push({
        path: abs('opencode.jsonc'),
        amend: (text) => amendConfig(text, id),
      });
    }
    if (kind === 'playbook') {
      const phrase = String(title).replace(/[\r\n|]/g, '-').trim() || id;
      amendments.push({
        path: abs('skills', 'playbook', 'SKILL.md'),
        amend: (text) => amendRouter(text, id, phrase),
      });
    }

    let vars;
    try {
      vars = {
        id,
        title,
        description,
        body: bodyText(body, readText),
      };
    } catch (error) {
      return fail(emit, error.message);
    }

    for (const target of targets) {
      let text;
      try {
        text = readText(path.join(pkgRoot, 'templates', target.template));
      } catch (error) {
        return fail(emit, `cannot read template ${target.template}: ${error.message}`);
      }
      const rendered = render(text, vars);
      if (TOKEN_RE.test(rendered)) {
        return fail(emit, `unresolved template token in ${target.template}`);
      }
      const problem = frontmatterError(rendered, kind, id);
      if (problem) return fail(emit, problem);
      target.text = rendered;
    }

    const originals = new Map();
    for (const target of targets) originals.set(target.path, tryRead(target.path));
    for (const amendment of amendments) {
      const current = tryRead(amendment.path);
      if (current === null) {
        return fail(emit, `cannot read file to amend: ${amendment.path}`);
      }
      originals.set(amendment.path, current);
      try {
        amendment.text = amendment.amend(current);
      } catch (error) {
        return fail(emit, `cannot amend ${amendment.path}: ${error.message}`);
      }
    }

    for (const target of targets) {
      if (originals.get(target.path) !== null && !force) {
        return fail(emit, `artifact already exists: ${target.path}`);
      }
    }

    if (dryRun) {
      for (const target of targets) emit(`would write ${target.path}`);
      for (const amendment of amendments) emit(`would amend ${amendment.path}`);
      return 0;
    }

    const plan = [
      ...targets.map((t) => ({ path: t.path, text: t.text, amend: false })),
      ...amendments.map((a) => ({ path: a.path, text: a.text, amend: true })),
    ];
    const written = [];
    try {
      for (const step of plan) {
        writeText(step.path, step.text);
        written.push(step);
      }
    } catch (error) {
      for (const step of written.reverse()) {
        try {
          const original = originals.get(step.path);
          if (original === null) rmSync(step.path, { force: true });
          else writeText(step.path, original);
        } catch (rollbackError) {
          emit(`evolve: rollback failed for ${step.path}: ${rollbackError.message}`);
        }
      }
      return fail(emit, `write failed: ${error.message}`);
    }

    try {
      const code = await runDoctor(configDir);
      if (typeof code !== 'number' || !Number.isFinite(code)) {
        return fail(emit, 'doctor returned no numeric exit code');
      }
      return Math.trunc(code);
    } catch (error) {
      return fail(emit, `doctor failed: ${error.message}`);
    }
  };
}
