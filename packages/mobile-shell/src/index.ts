import { el, button } from '@quadbridge/web-shell/dom';
import { startShell, type ShellLifecyclePort, type ShellPresentationElements, type ShellPresentationOptions, type ShellOptions } from '@quadbridge/web-shell';
import { Capacitor } from '@capacitor/core';
import { createNativeRequestTransport, nativeAppLifecycle, validateNativeBootstrapIdentity, type NativeRuntimeIdentity } from './native.js';
import { PlatformError } from '@quadbridge/contracts';
import type { RequestTransport } from '@quadbridge/client-core';

function mobileWorkspaces(snapshot: ShellPresentationOptions['snapshot']) {
  const experience = snapshot.product.experience;
  if (!experience) return snapshot.workspaces.map((workspace, index) => ({ workspace, routeId: workspace.id, label: workspace.label, order: index, mobilePriority: index }));
  return experience.navigation.map(item => {
    const workspace = snapshot.workspaces.find(candidate => candidate.id === item.workspaceId);
    return workspace ? { workspace, routeId: item.id, label: item.label, order: item.order, mobilePriority: item.mobilePriority } : undefined;
  }).filter((item): item is NonNullable<typeof item> => !!item).sort((a, b) => a.order - b.order || a.routeId.localeCompare(b.routeId));
}

function renderMobilePresentation({ root, snapshot, onTenantChange, onSignOut, onNavigate }: ShellPresentationOptions): ShellPresentationElements {
  if (snapshot.product.experience) {
    root.setAttribute('data-qb-surface', snapshot.product.experience.theme.surface);
    root.setAttribute('data-qb-text', snapshot.product.experience.theme.text);
    root.setAttribute('data-qb-accent', snapshot.product.experience.theme.accent);
    root.setAttribute('data-qb-density', snapshot.product.experience.theme.density);
  }
  const presentedWorkspaces = mobileWorkspaces(snapshot);
  const primary = [...presentedWorkspaces].sort((a, b) => a.mobilePriority - b.mobilePriority || a.routeId.localeCompare(b.routeId)).slice(0, 3);
  const primaryIds = new Set(primary.map(item => item.routeId));
  const overflow = presentedWorkspaces.filter(item => !primaryIds.has(item.routeId));
  const app = el('div', 'mobile-shell');
  const header = el('header', 'mobile-header');
  const title = el('div', 'mobile-title');
  title.append(el('span', 'eyebrow', snapshot.product.experience?.brand.name ?? 'PRODUCT WORKSPACE'), el('h1', '', snapshot.product.title));
  if (snapshot.product.experience?.brand.tagline) title.append(el('span', 'small muted', snapshot.product.experience.brand.tagline));
  const scope = el('label', 'mobile-tenant');
  scope.append(el('span', 'small muted', 'Tenant'));
  const select = el('select');
  select.setAttribute('aria-label', 'Tenant');
  for (const tenant of snapshot.tenants) {
    const option = el('option', '', tenant);
    option.value = tenant;
    option.selected = tenant === snapshot.scope.tenantId;
    select.append(option);
  }
  select.addEventListener('change', () => onTenantChange(select.value));
  scope.append(select);
  const accountButton = button('Account', () => {
    accountPanel.hidden = !accountPanel.hidden;
    accountButton.setAttribute('aria-expanded', String(!accountPanel.hidden));
  });
  accountButton.className = 'button secondary mobile-account-button';
  accountButton.setAttribute('aria-expanded', 'false');
  accountButton.setAttribute('aria-controls', 'mobile-account-panel');
  header.append(title, scope, accountButton);

  const accountPanel = el('section', 'mobile-account-panel');
  accountPanel.id = 'mobile-account-panel';
  accountPanel.hidden = true;
  accountPanel.setAttribute('aria-label', 'Account details');
  accountPanel.append(el('strong', '', snapshot.actor.id), el('p', 'small muted', `${snapshot.modules.length} selected modules`), el('p', 'small muted break', `Instance ${snapshot.scope.instanceId}`), button('Sign out', onSignOut));

  const noticeArea = el('div', 'notice mobile-notice');
  noticeArea.hidden = true;
  noticeArea.setAttribute('role', 'status');
  const content = el('main', 'content mobile-content');
  const contributionAside = el('section', 'mobile-contribution-slot mobile-contribution-aside');
  contributionAside.hidden = true;
  contributionAside.setAttribute('aria-label', 'Workspace information');
  const contributionFooter = el('section', 'mobile-contribution-slot mobile-contribution-footer');
  contributionFooter.hidden = true;
  contributionFooter.setAttribute('aria-label', 'Workspace tools');
  const contributionArea = el('div', 'mobile-contributions');
  contributionArea.append(contributionAside, contributionFooter);
  const morePanel = el('div', 'mobile-more-panel');
  morePanel.hidden = true;
  morePanel.setAttribute('aria-label', 'More workspaces');
  let closeMore = () => {};
  for (const item of overflow) {
    const link = el('a', 'mobile-more-link', item.label);
    link.setAttribute('data-workspace-path', item.workspace.path);
    link.href = `#${item.workspace.path}`;
    link.addEventListener('click', event => { event.preventDefault(); closeMore(); void onNavigate(item.routeId); });
    morePanel.append(link);
  }
  if (!presentedWorkspaces.length) morePanel.append(el('p', 'small muted', 'No business workspaces are selected for this product.'));
  const moreButton = button('More', () => {
    morePanel.hidden = !morePanel.hidden;
    moreButton.setAttribute('aria-expanded', String(!morePanel.hidden));
  });
  moreButton.className = 'mobile-nav-item mobile-more-button';
  moreButton.setAttribute('aria-expanded', 'false');
  moreButton.setAttribute('aria-controls', 'mobile-more-panel');
  closeMore = () => {
    morePanel.hidden = true;
    moreButton.setAttribute('aria-expanded', 'false');
  };
  morePanel.id = 'mobile-more-panel';
  const navigation = el('nav', 'mobile-bottom-nav');
  navigation.setAttribute('aria-label', 'Workspaces');
  for (const item of primary) {
    const link = el('a', 'mobile-nav-item', item.label);
    link.setAttribute('data-workspace-path', item.workspace.path);
    link.href = `#${item.workspace.path}`;
    link.addEventListener('click', event => { event.preventDefault(); void onNavigate(item.routeId); });
    navigation.append(link);
  }
  navigation.append(moreButton);
  app.append(header, accountPanel, noticeArea, content, contributionArea, morePanel, navigation);
  root.replaceChildren(app);
  return { content, noticeArea, contributionSlots: { 'workspace.aside': contributionAside, 'workspace.footer': contributionFooter } };
}

const browserLifecycle: ShellLifecyclePort = {
  bind(handlers) {
    const visibility = () => document.visibilityState === 'hidden' ? handlers.suspend() : handlers.resume();
    const pageHide = () => handlers.suspend();
    const pageShow = () => handlers.resume();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pageHide);
    window.addEventListener('pageshow', pageShow);
    if (document.visibilityState === 'hidden') handlers.suspend();
    else handlers.resume();
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
    };
  }
};

export function startMobileShell(options: ShellOptions): () => void {
  return startShell({ ...options, presentation: renderMobilePresentation, lifecycle: browserLifecycle });
}

export interface PackagedMobileShellOptions {
  root: HTMLElement;
  title: string;
  loaders: ShellOptions['loaders'];
  identity: NativeRuntimeIdentity;
  uiBindings?: ShellOptions['uiBindings'];
  experience?: ShellOptions['experience'];
}

/** Active fixed native profile; browser previews continue through startMobileShell. */
export function startPackagedMobileShell({ root, title, loaders, identity, uiBindings = [], experience }: PackagedMobileShellOptions): () => void {
  if (!Capacitor.isNativePlatform()) throw new PlatformError('INCOMPATIBLE', 'The packaged client requires its native application runtime');
  const nativeRequest = createNativeRequestTransport();
  const request: RequestTransport = async (path, init, signal, tenantId) => {
    const result = await nativeRequest(path, init, signal, tenantId);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && new URL(path, 'http://localhost').pathname === '/api/bootstrap')
      return validateNativeBootstrapIdentity(result, identity);
    return result;
  };
  return startShell({ root, title, loaders, uiBindings, request, presentation: renderMobilePresentation, lifecycle: nativeAppLifecycle, experience });
}
