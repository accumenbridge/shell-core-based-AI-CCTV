import type { UiContribution } from '@quadbridge/contracts/ui-contributions';
import { el } from '@quadbridge/web-shell/dom';
import type { Readiness } from './protocol.js';

export const provenancePanel: UiContribution = { mount(ctx) {
  const panel = el('details', 'veyviz-provenance'), summary = el('summary', 'vv-engine-summary'), dot = el('span', 'vv-engine-dot');
  dot.setAttribute('aria-hidden', 'true');
  const label = el('span', 'vv-engine-label', 'Analysis engine'), state = el('span', 'vv-engine-state', 'Checking availability…');
  state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite'); summary.append(dot, label, state);
  const content = el('div', 'vv-engine-content'), status = el('p', 'vv-engine-message', 'Checking the local model and recording profile.');
  content.append(status); panel.append(summary, content); ctx.root.append(panel);
  let closed = false;
  function fact(list: HTMLDListElement, name: string, value: string, code = false) {
    const item = el('div'), definition = el('dd'); definition.append(el(code ? 'code' : 'span', '', value || 'Unavailable'));
    item.append(el('dt', '', name), definition); list.append(item);
  }
  void ctx.api.get('/api/ai/readiness', ctx.signal).then(raw => {
    if (closed || ctx.signal.aborted) return;
    const ready = raw as Readiness, verified = ready.status === 'READY';
    panel.classList.add(verified ? 'is-verified' : 'is-unavailable'); state.textContent = verified ? 'Verified · Local CPU' : 'Unavailable'; status.textContent = ready.message;
    const facts = el('dl', 'vv-engine-facts'); fact(facts, 'Model profile', ready.profileId); fact(facts, 'Sample recording', ready.fixtureId);
    if (verified) fact(facts, 'Last integrity check', new Date(ready.verifiedAt).toLocaleString()); content.append(facts);
    if (verified) {
      const provenance = el('div', 'vv-engine-provenance'), hashes = el('dl', 'vv-engine-hashes');
      fact(hashes, 'Model SHA-256', ready.modelSha256, true); fact(hashes, 'Recording SHA-256', ready.sourceSha256, true);
      fact(hashes, 'Companion inventory SHA-256', ready.inventorySha256, true);
      const versions = el('details', 'vv-engine-packages'), packageVersions = Object.entries(ready.versions).sort(([a], [b]) => a.localeCompare(b));
      versions.append(el('summary', '', `Package versions (${packageVersions.length})`));
      const list = el('dl', 'vv-engine-version-list'); for (const [name, version] of packageVersions) fact(list, name, version);
      versions.append(list); provenance.append(hashes, versions); content.append(provenance);
    }
  }).catch(() => {
    if (closed || ctx.signal.aborted) return;
    panel.classList.add('is-unavailable'); state.textContent = 'Unavailable';
    status.textContent = 'The local analysis engine could not be verified. Saved results remain separate from this availability check.';
  });
  return () => { closed = true; panel.remove(); };
} };
