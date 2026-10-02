import { el, button } from '@quadbridge/web-shell/dom';
import { startShell, type ShellLifecyclePort, type ShellPresentationElements, type ShellPresentationOptions, type ShellOptions } from '@quadbridge/web-shell';

function renderMobilePresentation({ root, snapshot, onTenantChange, onSignOut }: ShellPresentationOptions): ShellPresentationElements {
  const app = el('div', 'mobile-shell');
  const header = el('header', 'mobile-header');
  const title = el('div', 'mobile-title');
  title.append(el('span', 'eyebrow', 'PRODUCT WORKSPACE'), el('h1', '', snapshot.product.title));
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
  const morePanel = el('div', 'mobile-more-panel');
  morePanel.hidden = true;
  morePanel.setAttribute('aria-label', 'More workspaces');
  let closeMore = () => {};
  for (const workspace of snapshot.workspaces) {
    const link = el('a', 'mobile-more-link', workspace.label);
    link.setAttribute('data-workspace-path', workspace.path);
    link.href = `#${workspace.path}`;
    link.addEventListener('click', () => closeMore());
    morePanel.append(link);
  }
  if (!snapshot.workspaces.length) morePanel.append(el('p', 'small muted', 'No business workspaces are selected for this product.'));
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
  for (const workspace of snapshot.workspaces.slice(0, 3)) {
    const link = el('a', 'mobile-nav-item', workspace.label);
    link.setAttribute('data-workspace-path', workspace.path);
    link.href = `#${workspace.path}`;
    navigation.append(link);
  }
  navigation.append(moreButton);
  app.append(header, accountPanel, noticeArea, content, morePanel, navigation);
  root.replaceChildren(app);
  return { content, noticeArea };
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
}

/** A fixed packaged build stays inert until a reviewed connection adapter exists. */
export function startPackagedMobileShell({ root, title }: PackagedMobileShellOptions): () => void {
  const screen = el('main', 'mobile-connection-state');
  screen.append(el('div', 'brand-symbol', 'Q'), el('span', 'eyebrow', 'MOBILE PRODUCT'), el('h1', '', title), el('span', 'pill', 'CONNECTION NOT CONFIGURED'), el('p', 'muted', 'This app has no approved sign-in or server connection yet.'), el('p', 'small muted', 'Ask the product administrator to finish mobile identity and API setup before using protected workspaces.'));
  root.replaceChildren(screen);
  return () => root.replaceChildren();
}
