import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  truncate,
  buildActivity,
  planAction,
  normalizeInterval,
  describe,
  gateAfterAction,
  prettifyModel,
  formatEffort,
} from '../src/presence.mjs';

// The snapshot carries retired fields on purpose: none of them may reach the
// card. openedAt is when OpenCode opened, not the turn's startedAt.
const snapshot = {
  model: 'deepseek-v4.1-flash',
  modelName: 'DeepSeek V4.1 Flash 1017',
  modelProviderID: 'opencode-go',
  effort: 'high',
  busy: true,
  openedAt: 1795869962203,
  startedAt: 123456789,
  title: 'Build the RPC plugin',
  project: 'oc-collections',
  agent: 'general',
  retrying: true,
  sessions: 3,
};
const opts = { appName: 'OpenCode', appVersion: '2.4.2', largeImage: 'uploaded-key' };
const card = (overrides = {}, options = {}) => buildActivity({ ...snapshot, ...overrides }, { ...opts, ...options });

test('LIMITS expose the Discord limits and are frozen', () => {
  assert.equal(LIMITS.TEXT, 128);
  assert.equal(LIMITS.IMAGE, 300);
  assert.equal(LIMITS.NAME, 128);
  assert.equal(LIMITS.BUTTON_LABEL, 32);
  assert.equal(LIMITS.BUTTON_URL, 512);
  assert.equal(LIMITS.BUTTONS, 2);
  assert.equal(LIMITS.IMAGE_TEXT_MIN, 2);
  assert.equal(Object.isFrozen(LIMITS), true);
});

test('details carries the model display name, state carries the reasoning level', () => {
  const { activity } = card();
  assert.equal(activity.details, 'Coding with DeepSeek V4.1 Flash 1017');
  assert.equal(activity.state, 'Reasoning High');
  assert.equal(activity.name, 'OpenCode');
  assert.equal(activity.type, 0);
});

test('the effort never appears on the details line', () => {
  const { activity } = card();
  assert.doesNotMatch(activity.details, /High|\u00b7|[()]/);
  assert.equal(activity.details, 'Coding with DeepSeek V4.1 Flash 1017');
  assert.equal(activity.state, 'Reasoning High');
});

test('prettifyModel falls back to a human name when no catalogue name is known', () => {
  assert.equal(prettifyModel('deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash');
  assert.equal(prettifyModel('some_model/x-high'), 'Some Model X High');
  assert.equal(prettifyModel(''), '');
  assert.equal(prettifyModel(undefined), '');
  assert.equal(card({ modelName: undefined }).activity.details, 'Coding with DeepSeek V4.1 Flash');
});

test('every level maps in one place, including an unknown id', () => {
  for (const [variant, level] of [
    ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'XHigh'],
    ['max', 'Max'], ['minimal', 'Minimal'], ['ultracode', 'Ultracode'], ['custom', 'Custom'],
  ]) {
    assert.equal(formatEffort(variant), level);
    assert.equal(card({ effort: variant }).activity.state, 'Reasoning ' + level);
  }
});

test('default, empty and missing variants omit state entirely', () => {
  assert.equal(formatEffort('default'), '');
  assert.equal(formatEffort('DEFAULT'), '');
  assert.equal(formatEffort(''), '');
  assert.equal(formatEffort(undefined), '');
  for (const effort of ['default', 'DEFAULT', '', undefined]) {
    const { activity } = card({ effort });
    assert.equal('state' in activity, false);
    assert.equal(activity.details, 'Coding with DeepSeek V4.1 Flash 1017');
  }
});

test('no model means no details and no reasoning line', () => {
  const { activity, reason } = buildActivity({ openedAt: 1795869962203 }, { appName: 'OpenCode' });
  assert.equal('details' in activity, false);
  assert.equal('state' in activity, false);
  assert.equal(reason, 'card: name + openedAt');
  const effortOnly = buildActivity({ effort: 'high' }, { appName: 'OpenCode' });
  assert.equal('state' in effortOnly.activity, false);
});

test('large_text is provider \u00b7 version and is omitted when neither is known', () => {
  assert.equal(card().activity.assets.large_text, 'opencode-go \u00b7 2.4.2');
  const neither = buildActivity({ ...snapshot, modelProviderID: undefined }, { appName: 'OpenCode', largeImage: 'key' });
  assert.deepEqual(neither.activity.assets, { large_image: 'key' });
  assert.equal(buildActivity(snapshot, { appName: 'OpenCode' }).activity.assets.large_text, 'opencode-go');
  assert.equal(buildActivity({ ...snapshot, modelProviderID: undefined }, {
    appName: 'OpenCode', appVersion: '2.4.2',
  }).activity.assets.large_text, '2.4.2');
});

test('no assets key without an image or a provider/version', () => {
  const none = buildActivity({ ...snapshot, modelProviderID: undefined }, { appName: 'OpenCode' });
  assert.equal('assets' in none.activity, false);
  const image = buildActivity({ ...snapshot, modelProviderID: undefined }, { appName: 'OpenCode', largeImage: 'asset' });
  assert.deepEqual(image.activity.assets, { large_image: 'asset' });
});

test('timestamps.start is floored seconds from openedAt and ignores busy', () => {
  const { activity } = card();
  assert.deepEqual(activity.timestamps, { start: 1795869962 });
  assert.deepEqual(card({ busy: false }).activity.timestamps, { start: 1795869962 });
  assert.equal('timestamps' in card({ openedAt: undefined }).activity, false);
  const startedOnly = buildActivity({ ...snapshot, openedAt: undefined }, opts);
  assert.equal('timestamps' in startedOnly.activity, false);
  const broken = card({ openedAt: Number.NaN });
  assert.equal('timestamps' in broken.activity, false);
});

test('a title in the snapshot cannot reach the card', () => {
  const { activity } = card();
  assert.equal(activity.details, 'Coding with DeepSeek V4.1 Flash 1017');
  assert.equal(JSON.stringify(activity).includes('Build the RPC plugin'), false);
});

test('buttons validate the URL, default an empty label to the host and cap at two', () => {
  const { activity } = card({}, {
    buttons: [
      { label: '', url: 'https://example.com/path' },
      { label: 'Bad', url: 'ftp://example.com' },
      { label: 'Chat', url: 'https://chat.example.com' },
      { label: 'Fourth', url: 'https://fourth.example.com' },
    ],
  });
  assert.deepEqual(activity.buttons, [
    { label: 'example.com', url: 'https://example.com/path' },
    { label: 'Chat', url: 'https://chat.example.com' },
  ]);
  const none = card({}, { buttons: [{ label: 'X', url: '/relative' }] });
  assert.equal('buttons' in none.activity, false);
});

test('button label and URL are truncated to their codepoint limits', () => {
  const long = 'x'.repeat(600);
  const { activity } = card({}, { buttons: [{ label: long, url: 'https://example.com/' + long }] });
  assert.equal(activity.buttons[0].label, 'x'.repeat(LIMITS.BUTTON_LABEL));
  assert.equal(activity.buttons[0].url.length, LIMITS.BUTTON_URL);
  assert.match(activity.buttons[0].url, /^https:/);
});

test('describe states the two text lines and nothing else', () => {
  assert.deepEqual(describe(snapshot), {
    details: 'Coding with DeepSeek V4.1 Flash 1017',
    state: 'Reasoning High',
  });
  assert.deepEqual(describe(), { details: '', state: '' });
  assert.deepEqual(Object.keys(describe(snapshot)), ['details', 'state']);
});

test('an empty app name is the only no-card case and reason names it', () => {
  const { activity, reason } = buildActivity(snapshot, { appName: '' });
  assert.equal(activity, null);
  assert.equal(reason, 'no app name: nothing to show');
  assert.equal(buildActivity().activity.name, 'OpenCode');
});

test('truncate keeps an emoji surrogate pair whole at the boundary', () => {
  assert.equal(truncate('a\u{1f600}b', 2), 'a\u{1f600}');
  assert.equal(Array.from(truncate('a\u{1f600}b', 2)).length, 2);
  assert.equal(truncate('\u{1f600}\u{1f600}\u{1f600}', 2), '\u{1f600}\u{1f600}');
  assert.equal(truncate('abc', 2), 'ab');
  assert.equal(truncate('abc', 0), '');
  assert.equal(truncate(undefined, 5), '');
});

test('truncate keeps an accented character whole without splitting its marks', () => {
  assert.equal(truncate('caf\u00e9x', 4), 'caf\u00e9');
  assert.equal(truncate('cafe\u0301', 5), 'cafe\u0301');
  assert.equal(truncate('cafe\u0301', 4), 'caf');
  assert.equal(truncate('a\u0301b', 2), 'a\u0301');
  assert.equal(truncate('x\u{1f469}\u200d\u{1f4bb}y', 3), 'x');
  assert.equal(truncate('x\u{1f469}\u200d\u{1f4bb}y', 4), 'x\u{1f469}\u200d\u{1f4bb}');
});

test('planAction is idle when the revision has not changed', () => {
  assert.deepEqual(planAction({ desired: true, revision: 1, sentRevision: 1, lastSentMs: 1000, interval: 4000 }, 2000), { action: 'idle', waitMs: 0 });
});

test('planAction clears without waiting or spending the interval budget', () => {
  assert.deepEqual(planAction({ desired: false, revision: 2, sentRevision: 1, lastSentMs: 1000, interval: 4000 }, 2000), { action: 'clear', waitMs: 0 });
});

test('planAction waits until lastSentMs plus the interval', () => {
  const request = { desired: true, revision: 2, sentRevision: 1, lastSentMs: 1000, interval: 4000 };
  assert.deepEqual(planAction(request, 2000), { action: 'wait', waitMs: 3000 });
  assert.deepEqual(planAction(request, 1234.5), { action: 'wait', waitMs: 3765.5 });
  assert.deepEqual(planAction(request, 5000), { action: 'send', waitMs: 0 });
  assert.deepEqual(planAction({ ...request, interval: 0 }, 2000), { action: 'send', waitMs: 0 });
});

test('planAction allows a first send when lastSentMs is zero', () => {
  assert.deepEqual(planAction({ desired: true, revision: 1, sentRevision: 0, lastSentMs: 0, interval: 4000 }, 5000), { action: 'send', waitMs: 0 });
});

test('normalizeInterval clamps small values and falls back on missing ones', () => {
  assert.equal(normalizeInterval(0), 0);
  assert.equal(normalizeInterval(500), 1000);
  assert.equal(normalizeInterval(-5), 1000);
  assert.equal(normalizeInterval(1000), 1000);
  assert.equal(normalizeInterval(5000), 5000);
  assert.equal(normalizeInterval(undefined), 4000);
  assert.equal(normalizeInterval(Number.NaN), 4000);
});

test('gateAfterAction stores the send time only when the gate did not move', () => {
  assert.equal(gateAfterAction('send', 100, 100, 5000), 5000);
  assert.equal(gateAfterAction('send', 100, 200, 5000), 200);
  assert.equal(gateAfterAction('clear', 100, 100, 5000), 100);
  assert.equal(gateAfterAction('wait', 100, 100, 5000), 100);
  assert.equal(gateAfterAction('idle', 100, 200, 5000), 200);
});
