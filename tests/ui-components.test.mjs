import test from 'node:test';
import assert from 'node:assert/strict';
import * as ui from '../packages/ui/dist/index.js';
import * as legacyDom from '../packages/web-shell/dist/dom.js';
import { installUiDomFixture } from '../tools/ui-component-fixtures.mjs';

test('UI03: public boundaries set complete defaults and reset nested palettes', () => {
  const restore = installUiDomFixture();
  try {
    const outer = document.createElement('main'), nested = document.createElement('section');
    ui.applyUiBoundary(outer, { surface: 'dark', accent: 'blue', density: 'compact' });
    ui.applyUiBoundary(nested, { surface: 'light' });
    assert.equal(outer.getAttribute('data-qb-ui-boundary'), '');
    assert.equal(outer.getAttribute('data-qb-surface'), 'dark');
    assert.equal(outer.getAttribute('data-qb-accent'), 'blue');
    assert.equal(outer.getAttribute('data-qb-density'), 'compact');
    assert.deepEqual(Object.fromEntries(nested.attributes), {
      'data-qb-ui-boundary': '', 'data-qb-surface': 'light', 'data-qb-text': 'standard',
      'data-qb-accent': 'teal', 'data-qb-density': 'comfortable'
    });
    ui.applyUiLayout(nested, 'operational');
    assert.equal(nested.getAttribute('data-qb-layout-mode'), 'operational');
  } finally { restore(); }
});

test('UI03: field controls keep unique labels, help and error associations with literal text', () => {
  const restore = installUiDomFixture();
  try {
    const firstInput = document.createElement('input'), secondInput = document.createElement('textarea');
    const first = ui.fieldControl('Title', firstInput, { required: true, maxLength: 120, help: 'Use a short title.' });
    const second = ui.fieldControl('Details', secondInput, { required: false, maxLength: 64000, error: '<b>Enter details</b>' });
    assert.notEqual(firstInput.id, secondInput.id);
    assert.equal(first.wrap.children[0].textContent, 'Title');
    assert.equal(firstInput.required, true);
    assert.equal(firstInput.maxLength, 120);
    assert.equal(firstInput.getAttribute('aria-describedby'), `${firstInput.id}-help`);
    assert.equal(secondInput.required, false);
    assert.equal(secondInput.maxLength, 64000);
    assert.equal(secondInput.getAttribute('aria-invalid'), 'true');
    assert.equal(secondInput.getAttribute('aria-describedby'), `${secondInput.id}-error`);
    assert.equal(second.wrap.children.at(-1).textContent, '<b>Enter details</b>');
    second.setError();
    assert.equal(secondInput.getAttribute('aria-invalid'), null);
    assert.equal(secondInput.getAttribute('aria-describedby'), null);
  } finally { restore(); }
});

test('UI03: action and unknown status controls expose native state and caller wording', () => {
  const restore = installUiDomFixture();
  try {
    const action = ui.actionButton('Save', () => {}, { pending: true, pendingText: 'Waiting for owner result' });
    assert.equal(action.type, 'button');
    assert.equal(action.disabled, true);
    assert.equal(action.getAttribute('aria-busy'), 'true');
    assert.match(action.textContent, /Waiting for owner result/);
    const status = ui.statusNotice('unknown', 'The original command may still have committed.');
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('data-qb-status'), 'unknown');
    assert.match(status.textContent, /Outcome unknown/);
    assert.match(status.textContent, /may still have committed/);
    assert.doesNotMatch(status.textContent, /failed|rejected/i);
  } finally { restore(); }
});

test('UI03: web-shell legacy DOM helpers remain delegates with their original classes and form lifetime', async () => {
  const restore = installUiDomFixture();
  try {
    const element = legacyDom.el('p', 'legacy', '<strong>literal</strong>');
    assert.equal(element.className, 'legacy');
    assert.equal(element.textContent, '<strong>literal</strong>');
    const action = legacyDom.button('Open', () => {}, 'button secondary');
    assert.equal(action.className, 'button secondary');
    assert.equal(action.type, 'button');
    const legacyField = legacyDom.field('Details', 'details', true);
    assert.equal(legacyField.wrap.className, 'field');
    assert.equal(legacyField.input.name, 'details');
    assert.equal(legacyField.input.required, true);
    assert.equal(legacyField.input.maxLength, 64000);
    assert.equal(legacyDom.section().className, 'card');
    assert.equal(legacyDom.heading('Title', 'Subtitle').className, 'section-heading');
    assert.equal(legacyDom.statistic('Rows', 2).className, 'stat-card');
    assert.equal(legacyDom.emptyState('Empty', 'Details').className, 'list-empty');

    const form = document.createElement('form'), controller = new AbortController();
    let calls = 0, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    legacyDom.formAction(form, 'Submit', async () => { calls++; await pending; }, controller.signal, () => {});
    const submitting = form.dispatch('submit');
    assert.equal(calls, 1);
    assert.equal(form.children[0].type, 'submit');
    assert.equal(form.children[0].disabled, true);
    assert.equal(form.children[0].getAttribute('aria-busy'), 'true');
    assert.equal(form.children[1].hidden, false);
    await form.dispatch('submit');
    assert.equal(calls, 1);
    finish();
    await submitting;
    assert.equal(form.children[0].disabled, false);
    assert.equal(form.children[0].getAttribute('aria-busy'), null);
    assert.equal(form.children[1].hidden, true);
  } finally { restore(); }
});
