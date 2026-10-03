import type { UiContribution } from '@quadbridge/contracts/ui-contributions';
import type { Workspace } from '@quadbridge/contracts';
import { el } from '@quadbridge/web-shell/dom';
import type { Readiness } from './protocol.js';

function fact(list: HTMLDListElement, name: string, value: string, code = false) {
  const item = el('div'), definition = el('dd'); definition.append(el(code ? 'code' : 'span', '', value || 'Unavailable'));
  item.append(el('dt', '', name), definition); list.append(item);
}

export const healthWorkspace: Workspace = { mount(ctx) {
  const page = el('section', 'veyviz-health'), header = el('header', 'vv-health-heading'), heading = el('div');
  heading.append(el('h1', '', 'System Health'), el('p', '', 'Local recorded-analysis profile and software provenance.'));
  const refresh = el('button', 'button secondary', 'Refresh status'); refresh.type = 'button'; header.append(heading, refresh);
  const tabs = el('div', 'vv-health-section-label'); tabs.append(el('span', '', 'Profile integrity'), el('span', 'vv-health-scope', 'Recorded media · Local CPU'));
  const announcement = el('p', 'vv-health-announcement'); announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite');
  const content = el('div', 'vv-health-content'); page.append(header, tabs, announcement, content); ctx.root.append(page);
  let closed = false, busy = false;
  const active = () => !closed && !ctx.signal.aborted;
  function render(ready: Readiness) {
    content.replaceChildren();
    const verified = ready.status === 'READY', banner = el('section', `vv-health-status ${verified ? 'is-verified' : 'is-unavailable'}`);
    const symbol = el('span', 'vv-health-status-symbol', verified ? '✓' : '!'); symbol.setAttribute('aria-hidden', 'true');
    const summary = el('div'); summary.append(el('h2', '', verified ? 'Recorded-analysis profile verified' : 'Analysis profile unavailable'),
      el('p', '', verified ? 'The recording, model and installed companion match the admitted local profile.' : 'The local profile could not be verified. Check the readiness details below.'));
    const scope = el('span', 'vv-health-status-scope', 'FILE INTEGRITY'); banner.append(symbol, summary, scope); content.append(banner);
    const grid = el('div', 'vv-health-grid'), pipeline = el('section', 'vv-health-card vv-health-pipeline');
    const pipelineHeading = el('div', 'vv-health-card-heading'); pipelineHeading.append(el('h2', '', 'Configured analysis path'), el('span', '', 'RF-DETR · CPU'));
    pipeline.append(pipelineHeading, el('p', 'vv-health-card-note', 'The configured path below describes recorded analysis. Status checks verify local files; they do not run this pipeline.'));
    const stages = el('ol', 'vv-health-stages');
    for (const [name, value, detail, state] of [
      ['Recording input', ready.fixtureId, 'Installed MIVIA sample', verified ? 'Recording file verified' : 'Not verified'],
      ['Person detection', ready.modelId, 'RF-DETR small · ONNX · CPU', verified ? 'Model file verified' : 'Not verified'],
      ['Sample results', 'Sampled detections and provenance', 'Bounded recorded-frame analysis', 'Requires an analysis run']
    ]) {
      const stage = el('li', 'vv-health-stage'); stage.append(el('span', 'vv-health-stage-name', name), el('strong', '', value), el('p', '', detail), el('span', `vv-health-stage-state${verified && name !== 'Sample results' ? ' is-verified' : ''}`, state)); stages.append(stage);
    }
    pipeline.append(stages);
    const limit = el('div', 'vv-health-limit'); limit.append(el('strong', '', 'Verification scope'), el('p', '', 'Readiness confirms the admitted recording, model and installed companion inventory. It does not establish live-camera availability, detection accuracy, current CPU load, or successful execution.'));
    pipeline.append(limit); grid.append(pipeline);
    const profile = el('section', 'vv-health-card vv-health-profile'), profileHeading = el('div', 'vv-health-card-heading'); profileHeading.append(el('h2', '', 'Local profile')); profile.append(profileHeading);
    const facts = el('dl', 'vv-health-facts');
    fact(facts, 'Profile', ready.profileId); fact(facts, 'Recording', ready.fixtureId); fact(facts, 'Execution target', 'Local CPU');
    fact(facts, 'Last integrity verification', verified ? new Date(ready.verifiedAt).toLocaleString(ctx.locale) : 'Unavailable');
    fact(facts, 'Workspace tenant', ctx.scope.tenantId); profile.append(facts, el('p', 'vv-health-profile-note', 'Refresh retrieves the current readiness report. This is not a live monitoring connection.')); grid.append(profile); content.append(grid);
    if (verified) {
      const packages = Object.entries(ready.versions).sort(([a], [b]) => a.localeCompare(b));
      const packageCard = el('section', 'vv-health-card vv-health-package-card'), packageHeader = el('div', 'vv-health-card-heading');
      packageHeader.append(el('h2', '', 'Installed software'), el('span', '', `${packages.length} captured versions`)); packageCard.append(packageHeader);
      const packageIntro = el('p', 'vv-health-card-note', 'Versions reported by the verified companion inventory. Availability does not mean a process is currently running.'); packageCard.append(packageIntro);
      const important = new Set(['python', 'onnxruntime', 'numpy', 'av', 'opencv-python-headless', 'veyviz-model-rfdetr', 'veyviz-source-recording']);
      const highlights = el('dl', 'vv-health-package-highlights');
      for (const [name, version] of packages) if (important.has(name)) fact(highlights, name, version);
      packageCard.append(highlights);
      const all = el('details', 'vv-health-disclosure'); all.append(el('summary', '', `All package versions (${packages.length})`));
      const versions = el('dl', 'vv-health-version-list'); for (const [name, version] of packages) fact(versions, name, version); all.append(versions); packageCard.append(all); content.append(packageCard);
      const integrity = el('details', 'vv-health-card vv-health-disclosure vv-health-integrity'); integrity.append(el('summary', '', 'Artifact integrity · SHA-256 fingerprints'));
      integrity.append(el('p', 'vv-health-integrity-message', ready.message));
      const hashes = el('dl', 'vv-health-hashes'); fact(hashes, 'Recording', ready.sourceSha256, true); fact(hashes, 'RF-DETR model', ready.modelSha256, true); fact(hashes, 'Companion inventory', ready.inventorySha256, true); integrity.append(hashes); content.append(integrity);
    } else {
      const unavailable = el('section', 'vv-health-card vv-health-unavailable');
      unavailable.append(el('h2', '', 'No verified provenance available'), el('p', '', 'The model, recording and installed package fingerprints cannot be presented as verified until this profile is available. Use Refresh status after the local profile has been restored. Saved analysis records are separate from this check.'));
      const details = el('details', 'vv-health-disclosure'); details.append(el('summary', '', 'Readiness details'), el('p', 'vv-health-integrity-message', ready.message)); unavailable.append(details); content.append(unavailable);
    }
  }
  async function load() {
    if (!active() || busy) return;
    busy = true; refresh.disabled = true; refresh.textContent = 'Checking…'; content.setAttribute('aria-busy', 'true');
    announcement.textContent = 'Checking recorded-analysis profile…';
    content.replaceChildren(el('div', 'vv-health-loading', 'Reading the local profile integrity report…'));
    try {
      const ready = await ctx.api.get('/api/ai/readiness', ctx.signal) as Readiness;
      if (!active()) return;
      render(ready); announcement.textContent = ready.status === 'READY' ? 'Profile verification report loaded.' : 'The analysis profile is unavailable.';
    } catch (error) {
      if (!active()) return;
      announcement.textContent = 'The readiness report could not be loaded.';
      const failure = el('section', 'vv-health-card vv-health-unavailable');
      failure.append(el('h2', '', 'System Health unavailable'), el('p', '', error instanceof Error ? error.message : 'Check the connection and try again.'), el('p', '', 'Use Refresh status to retry. No previous readiness result is being presented as current.')); content.replaceChildren(failure);
    } finally {
      busy = false;
      if (active()) { refresh.disabled = false; refresh.textContent = 'Refresh status'; content.setAttribute('aria-busy', 'false'); }
    }
  }
  refresh.addEventListener('click', () => void load(), { signal: ctx.signal }); void load();
  return () => { closed = true; page.remove(); };
} };

export const provenancePanel: UiContribution = { mount(ctx) {
  const panel = el('details', 'veyviz-provenance'), summary = el('summary', 'vv-engine-summary'), dot = el('span', 'vv-engine-dot');
  dot.setAttribute('aria-hidden', 'true');
  const label = el('span', 'vv-engine-label', 'Analysis engine'), state = el('span', 'vv-engine-state', 'Checking availability…');
  state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite'); summary.append(dot, label, state);
  const content = el('div', 'vv-engine-content'), status = el('p', 'vv-engine-message', 'Checking the local model and recording profile.');
  content.append(status); panel.append(summary, content); ctx.root.append(panel);
  let closed = false;
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
