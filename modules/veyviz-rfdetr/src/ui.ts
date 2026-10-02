import type { UiContribution } from '@quadbridge/contracts/ui-contributions';
import { el, section, statistic } from '@quadbridge/web-shell/dom';
import type { Readiness } from './protocol.js';

export const provenancePanel: UiContribution = { mount(ctx) {
  const panel = section('card veyviz-provenance'), title = el('h3', '', 'Inference provenance'), status = el('p', 'small muted', 'Checking the selected local model profile…');
  panel.append(title, status); ctx.root.append(panel);
  let closed = false;
  void ctx.api.get('/api/ai/readiness', ctx.signal).then(raw => {
    if (closed || ctx.signal.aborted) return;
    const ready = raw as Readiness;
    status.textContent = ready.status === 'READY' ? `Verified at ${new Date(ready.verifiedAt).toLocaleString()} · ${ready.message}` : ready.message;
    const facts = el('div', 'stat-grid veyviz-provenance-facts');
    facts.append(statistic('Profile', ready.profileId, ready.status === 'READY' ? 'Local CPU' : ready.status),
      statistic('Recording digest', ready.sourceSha256 ? `${ready.sourceSha256.slice(0, 12)}…` : 'Unavailable', ready.fixtureId),
      statistic('Model digest', ready.modelSha256 ? `${ready.modelSha256.slice(0, 12)}…` : 'Unavailable', ready.modelId));
    panel.append(facts);
    if (ready.status === 'READY') {
      const versions = el('details'), summary = el('summary', '', `Verified package inventory · ${Object.keys(ready.versions).length} versions`), list = el('ul', 'small muted');
      versions.append(summary);
      for (const [name, version] of Object.entries(ready.versions).sort(([a], [b]) => a.localeCompare(b))) list.append(el('li', '', `${name} ${version}`));
      versions.append(list, el('p', 'small muted', `Companion inventory SHA-256 ${ready.inventorySha256}`)); panel.append(versions);
    }
  }).catch(error => { if (!closed && !ctx.signal.aborted) status.textContent = error instanceof Error ? error.message : 'Readiness could not be verified'; });
  return () => { closed = true; };
} };
