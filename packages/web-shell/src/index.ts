import { PlatformError, type Scope, type Workspace, type WorkspaceContext } from '@quadbridge/contracts';
import { createScopedWorkspaceApi, requestJson } from '@quadbridge/client-core';
import { UI_CONTRIBUTION_SLOTS, type UiContribution, type UiContributionBinding, type UiContributionContext, type UiContributionDescriptor, type UiContributionSlot } from '@quadbridge/contracts/ui-contributions';
import { el, button, field } from './dom.js';
export interface ShellSnapshot {
    scope: Scope;
    actor: {
        id: string;
        kind: string;
    };
    tenants: string[];
    permissions: string[];
    product: {
        id: string;
        title: string;
        description: string;
        layout: string;
        version: string;
    };
    abi: string;
    modules: {
        id: string;
        version: string;
        mode: string;
    }[];
    operations: {
        method: string;
        path: string;
        moduleId: string;
    }[];
    workspaces: {
        id: string;
        label: string;
        path: string;
        moduleId: string;
        export: string;
    }[];
    uiContributions?: (UiContributionDescriptor & { moduleId: string })[];
}
interface Bootstrap extends ShellSnapshot {}
export interface ShellPresentationOptions {
    root: HTMLElement;
    snapshot: ShellSnapshot;
    onTenantChange(tenantId: string): void;
    onSignOut(): void;
}
export interface ShellPresentationElements {
    content: HTMLElement;
    noticeArea: HTMLElement;
    contributionSlots?: Partial<Record<UiContributionSlot, HTMLElement>>;
    contributionLayout?: HTMLElement;
}
export type ShellPresentation = (options: ShellPresentationOptions) => ShellPresentationElements;
export interface ShellLifecycleHandlers {
    suspend(): void;
    resume(): void;
}
export interface ShellLifecyclePort {
    bind(handlers: ShellLifecycleHandlers): () => void;
}
export interface ShellOptions {
    root: HTMLElement;
    title: string;
    /** Build-owned module IDs. The export is resolved from the accepted workspace declaration. */
    loaders: Readonly<Record<string, () => Promise<Record<string, unknown>>>>;
    /** Literal bindings validated from the selected product's reviewed solution source. */
    uiBindings?: readonly UiContributionBinding[];
    presentation?: ShellPresentation;
    lifecycle?: ShellLifecyclePort;
}
function renderDesktopPresentation({ root, snapshot: snap, onTenantChange, onSignOut }: ShellPresentationOptions): ShellPresentationElements {
    const shell = el('div', `shell ${snap.product.layout === 'top' ? 'top-layout' : ''}`), side = el('aside', 'sidebar');
    const brand = el('div', 'brand-row');
    brand.append(el('span', 'brand-symbol', 'Q'), el('span', 'brand', 'Quadbridge'));
    side.append(brand, el('span', 'eyebrow product-eyebrow', 'PRODUCT WORKSPACE'), el('span', 'product-name', snap.product.title), el('p', 'muted small', snap.product.description));
    const nav = el('nav');
    nav.setAttribute('aria-label', 'Workspaces');
    for (const workspace of snap.workspaces) {
        const link = el('a', 'nav-item', workspace.label);
        link.setAttribute('data-workspace-path', workspace.path);
        link.href = `#${workspace.path}`;
        nav.append(link);
    }
    side.append(nav);
    const meta = el('div', 'sidebar-meta');
    meta.append(el('span', 'pill', 'LOCAL DEVELOPER PROFILE'), el('p', 'small muted', `${snap.modules.length} selected modules`), el('p', 'small muted break', snap.scope.instanceId));
    side.append(meta);
    const main = el('main', 'main'), header = el('header', 'header'), scope = el('label', 'scope-label', 'Tenant'), select = el('select');
    select.setAttribute('aria-label', 'Tenant');
    for (const tenant of snap.tenants) {
        const option = el('option', '', tenant);
        option.value = tenant;
        option.selected = tenant === snap.scope.tenantId;
        select.append(option);
    }
    select.addEventListener('change', () => onTenantChange(select.value));
    scope.append(select);
    header.append(scope, el('span', 'small muted', snap.actor.id), button('Sign out', onSignOut));
    const noticeArea = el('div', 'notice');
    noticeArea.hidden = true;
    noticeArea.setAttribute('role', 'status');
    const contributionLayout = el('div', 'workspace-contribution-layout');
    const content = el('div', 'content');
    const asideSlot = el('aside', 'content workspace-contribution-slot');
    asideSlot.hidden = true;
    contributionLayout.append(content, asideSlot);
    const footerSlot = el('footer', 'content workspace-contribution-footer');
    footerSlot.hidden = true;
    main.append(header, noticeArea, contributionLayout, footerSlot);
    shell.append(side, main);
    root.replaceChildren(shell);
    return { content, noticeArea, contributionLayout, contributionSlots: { 'workspace.aside': asideSlot, 'workspace.footer': footerSlot } };
}
/** Maintained shell. Requested scope is never the active workspace's request scope. */
export function startShell({ root, title, loaders, uiBindings = [], presentation = renderDesktopPresentation, lifecycle }: ShellOptions) {
    let bootstrap: Bootstrap | undefined, requestedTenant: string | undefined;
    let generation = 0, active: AbortController | undefined, cleanup: (() => void) | undefined;
    let contributionSlots: ShellPresentationElements['contributionSlots'], contributionLayout: HTMLElement | undefined;
    let contributionControllers: AbortController[] = [], contributionCleanups: (() => void)[] = [];
    let bootstrapAbort: AbortController | undefined, refreshEpoch = 0, refreshing = false;
    let content: HTMLElement | undefined, noticeArea: HTMLElement | undefined;
    let stopped = false, suspended = false, logoutInProgress = false, loggedOut = false, signature = '', sessionKnown = false, needsRender = true;
    function clearContributionViews() {
        for (const controller of contributionControllers.splice(0)) controller.abort();
        for (const dispose of contributionCleanups.splice(0).reverse()) {
            try { dispose(); }
            catch { /* a contribution cannot prevent shell cleanup */ }
        }
        for (const slot of Object.values(contributionSlots ?? {})) {
            slot?.replaceChildren();
            if (slot) slot.hidden = true;
        }
        if (contributionLayout) contributionLayout.className = 'workspace-contribution-layout';
    }
    function clearView() {
        generation++;
        active?.abort();
        active = undefined;
        try {
            cleanup?.();
        }
        catch { /* one provider cannot prevent shell cleanup */ }
        cleanup = undefined;
        clearContributionViews();
        content?.replaceChildren();
    }
    function invalidateScope() {
        bootstrap = undefined;
        signature = '';
        needsRender = true;
        clearView();
    }
    function notice(message: string) {
        if (noticeArea) {
            noticeArea.textContent = message;
            noticeArea.hidden = false;
        }
    }
    const request = (path: string, init: RequestInit = {}, signal?: AbortSignal, tenantId?: string) => requestJson(path, init, signal, tenantId);
    function renderLogin() {
        invalidateScope();
        root.replaceChildren();
        content = undefined;
        noticeArea = undefined;
        contributionSlots = undefined;
        contributionLayout = undefined;
        const welcome = el('section', 'login-story');
        const monogram = el('div', 'brand-symbol', 'Q');
        welcome.append(monogram, el('span', 'eyebrow', 'QUADBRIDGE PRODUCT PLATFORM'), el('h2', '', 'One foundation.\nYour next product.'), el('p', 'muted', 'A shared application shell. Your selected modules. Separate business ownership.'));
        const stack = el('div', 'foundation-stack');
        for (const [name, detail] of [['Web shell', 'Session · navigation · workspace'], ['Product modules', 'Your operations and business rules'], ['Owner stores', 'Scoped records and durable receipts']]) {
            const row = el('div', 'foundation-layer');
            row.append(el('span', 'layer-symbol', '◇'), el('strong', '', name), el('span', 'small muted', detail));
            stack.append(row);
        }
        welcome.append(stack, el('p', 'small muted', 'LOCAL DEVELOPER PROFILE · No cloud account required'));
        const loginLayout = el('div', 'login-layout');
        const card = el('main', 'login-card');
        card.append(el('span', 'eyebrow', 'QUADBRIDGE / PRODUCT PLATFORM'), el('h1', '', title), el('p', 'muted', 'Local developer profile. Use the credentials generated by the launcher.'));
        const form = el('form'), name = field('Username', 'username'), password = field('Password', 'password');
        password.input.setAttribute('type', 'password');
        password.input.setAttribute('autocomplete', 'current-password');
        name.input.setAttribute('autocomplete', 'username');
        const error = el('p', 'error');
        error.setAttribute('role', 'alert');
        const submit = el('button', 'button', 'Sign in');
        submit.type = 'submit';
        form.append(name.wrap, password.wrap, submit, error);
        let pending = false;
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (pending || stopped)
                return;
            pending = true;
            submit.disabled = true;
            try {
                await request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name.input.value, password: password.input.value }) });
                if (stopped)
                    return;
                requestedTenant = undefined;
                loggedOut = false;
                sessionKnown = true;
                await refresh(true);
            }
            catch (e) {
                error.textContent = e instanceof Error ? e.message : 'Sign-in failed';
            }
            finally {
                pending = false;
                submit.disabled = false;
            }
        });
        card.append(form);
        loginLayout.append(welcome, card);
        root.append(loginLayout);
    }
    function accessFailure(error: unknown) {
        invalidateScope();
        if (error instanceof PlatformError && error.code === 'UNAUTHENTICATED') {
            sessionKnown = false;
            requestedTenant = undefined;
            renderLogin();
            return;
        }
        const message = error instanceof Error ? error.message : 'Unable to refresh access';
        if (!content) {
            root.replaceChildren();
            content = el('main', 'login-card');
            root.append(content);
        }
        content.append(el('h2', '', 'Workspace unavailable'), el('p', 'muted', message), button('Retry access', () => void refresh(true)));
        notice('Access could not be confirmed. The previous workspace has been cleared.');
    }
    async function mountContributions(selected: ShellSnapshot['workspaces'][number], snap: Bootstrap, parent: AbortController, current: () => boolean) {
        for (const binding of uiBindings) {
            if (!current()) return;
            if (binding.workspaceId !== selected.id || !UI_CONTRIBUTION_SLOTS.includes(binding.slot)) continue;
            const slot = contributionSlots?.[binding.slot];
            const descriptor = snap.uiContributions?.find(item => item.id === binding.contributionId);
            if (!slot || !descriptor || !snap.modules.some(module => module.id === descriptor.moduleId) ||
                !snap.permissions.includes(descriptor.permission)) continue;
            const loader = Object.hasOwn(loaders, descriptor.moduleId) ? loaders[descriptor.moduleId] : undefined;
            if (!loader) continue;

            const controller = new AbortController();
            const abortFromParent = () => controller.abort();
            parent.signal.addEventListener('abort', abortFromParent, { once: true });
            contributionControllers.push(controller);
            const contributionCurrent = () => current() && !controller.signal.aborted;
            const scoped = createScopedWorkspaceApi({
                operations: snap.operations,
                moduleId: descriptor.moduleId,
                tenantId: snap.scope.tenantId,
                signal: controller.signal,
                isCurrent: contributionCurrent,
                origin: () => location.origin,
                onAccessFailure: accessFailure,
                request
            });
            const contributionRoot = el('section', 'workspace-contribution-item');
            slot.append(contributionRoot);
            slot.hidden = false;
            if (binding.slot === 'workspace.aside' && contributionLayout)
                contributionLayout.className = 'workspace-contribution-layout with-aside';
            try {
                const loaded = await loader();
                if (!contributionCurrent()) return;
                const contribution = loaded && Object.hasOwn(loaded, descriptor.export)
                    ? loaded[descriptor.export] as UiContribution | undefined : undefined;
                if (!contribution || typeof contribution.mount !== 'function')
                    throw new PlatformError('INCOMPATIBLE', `Contribution ${descriptor.id} is unavailable`);
                const context: UiContributionContext = {
                    root: contributionRoot,
                    scope: Object.freeze({ ...snap.scope }),
                    actor: Object.freeze({ ...snap.actor }),
                    signal: controller.signal,
                    locale: 'en',
                    permissions: Object.freeze([descriptor.permission]),
                    api: Object.freeze({ get: (path: string, signal?: AbortSignal) => scoped.get(path, signal) }),
                    notice: message => { if (contributionCurrent()) notice(message); }
                };
                const dispose = contribution.mount(context);
                if (dispose && typeof (dispose as unknown as { then?: unknown }).then === 'function') {
                    void Promise.resolve(dispose as unknown as Promise<unknown>).catch(() => undefined);
                    throw new PlatformError('INCOMPATIBLE', 'Contribution mounts must be synchronous');
                }
                if (typeof dispose === 'function') contributionCleanups.push(dispose);
            }
            catch {
                if (contributionCurrent()) contributionRoot.replaceChildren(el('p', 'muted', `${descriptor.label} is unavailable.`));
            }
            finally {
                parent.signal.removeEventListener('abort', abortFromParent);
            }
        }
    }
    async function mountSelected() {
        // A hash event during a scope replacement cannot use the obsolete bootstrap.
        if (!bootstrap || stopped || suspended || logoutInProgress || !content)
            return;
        clearView();
        const ownGeneration = generation, controller = new AbortController();
        active = controller;
        const snap = bootstrap;
        const current = () => !stopped && !controller.signal.aborted && ownGeneration === generation && bootstrap === snap;
        const path = location.hash.slice(1) || snap.workspaces[0]?.path;
        // Presentation only: navigation never changes the accepted request scope.
        for (const a of Array.from(root.querySelectorAll?.('[data-workspace-path]') ?? [])) {
            a.setAttribute('aria-current', a.getAttribute('data-workspace-path') === path ? 'page' : 'false');
        }
        const selected = snap.workspaces.find(w => w.path === path);
        if (!selected && snap.modules.length) {
            content.append(el('h2', '', 'Choose an available workspace'), el('p', 'muted', 'This route is not selected or not permitted. Use the workspace navigation.'));
            return;
        }
        if (!selected) {
            const welcome = el('section', 'card empty-state');
            welcome.append(el('span', 'eyebrow', 'NEUTRAL HOST'), el('h2', '', 'The shell is running without a domain.'), el('p', 'muted', 'This product has no selected business workspaces. Add a reviewed module through its product definition; do not edit the shell.'), el('p', 'muted', `${snap.modules.length} selected modules · ${snap.abi}`));
            const blocks = el('div', 'neutral-blocks');
            for (const [label, detail] of [['01 / Application shell', 'Session, context and navigation are available.'], ['02 / Module boundary', 'Add business features through a product definition.'], ['03 / Owned operations', 'Keep each module’s records and decisions with its owner.']]) {
                const block = el('div', 'neutral-block');
                block.append(el('span', 'eyebrow', label), el('p', 'muted', detail));
                blocks.append(block);
            }
            welcome.append(blocks);
            content.append(welcome);
            return;
        }
        const loader = Object.hasOwn(loaders, selected.moduleId) ? loaders[selected.moduleId] : undefined;
        if (!loader) {
            notice('Selected workspace is not in this frontend build.');
            return;
        }
        const stage = el('div', 'workspace');
        content.append(stage);
        stage.append(el('p', 'muted', 'Opening workspace…'));
        try {
            const loaded = await loader();
            if (!current())
                return;
            const provider = Object.hasOwn(loaded, selected.export) ? loaded[selected.export] as Workspace | undefined : undefined;
            if (!provider || typeof provider.mount !== 'function')
                throw new PlatformError('INCOMPATIBLE', `Workspace export ${selected.export} is unavailable`);
            stage.replaceChildren();
            const api = createScopedWorkspaceApi({
                operations: snap.operations,
                moduleId: selected.moduleId,
                tenantId: snap.scope.tenantId,
                signal: controller.signal,
                isCurrent: current,
                origin: () => location.origin,
                onAccessFailure: accessFailure,
                request
            });
            const ctx: WorkspaceContext = {
                root: stage, scope: Object.freeze({ ...snap.scope }), signal: controller.signal, locale: 'en', permissions: Object.freeze([...snap.permissions]),
                notice: message => { if (current())
                    notice(message); },
                api
            };
            cleanup = provider.mount(ctx) || undefined;
            await mountContributions(selected, snap, controller, current);
        }
        catch (e) {
            if (current())
                stage.replaceChildren(el('h2', '', 'Workspace unavailable'), el('p', 'muted', e instanceof Error ? e.message : 'Provider failed'), button('Try again', () => void mountSelected()));
        }
    }
    function renderShell() {
        if (!bootstrap)
            return;
        clearView();
        needsRender = false;
        const snap = bootstrap;
        const view = presentation({
            root,
            snapshot: snap,
            onTenantChange: tenantId => {
                if (stopped || !snap.tenants.includes(tenantId)) return;
                requestedTenant = tenantId;
                invalidateScope();
                notice('Loading authorized tenant context…');
                void refresh(true);
            },
            onSignOut: () => {
                if (logoutInProgress || stopped) return;
                logoutInProgress = true;
                loggedOut = false;
                bootstrapAbort?.abort();
                refreshEpoch++;
                sessionKnown = false;
                invalidateScope();
                root.replaceChildren(el('p', 'muted', 'Signing out…'));
                content = undefined;
                noticeArea = undefined;
                void request('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
                    .catch(() => undefined)
                    .finally(() => {
                        logoutInProgress = false;
                        loggedOut = true;
                        sessionKnown = false;
                        requestedTenant = undefined;
                        if (!stopped && !suspended) renderLogin();
                    });
            }
        });
        content = view.content;
        noticeArea = view.noticeArea;
        contributionSlots = view.contributionSlots;
        contributionLayout = view.contributionLayout;
        void mountSelected();
    }
    async function refresh(force = false) {
        if (stopped || suspended || logoutInProgress || loggedOut || (refreshing && !force))
            return;
        bootstrapAbort?.abort();
        const controller = new AbortController();
        bootstrapAbort = controller;
        const epoch = ++refreshEpoch, requested = requestedTenant;
        refreshing = true;
        try {
            const next = await request('/api/bootstrap', {}, controller.signal, requested) as Bootstrap;
            if (stopped || controller.signal.aborted || epoch !== refreshEpoch)
                return;
            if (!next.scope || (requested && next.scope.tenantId !== requested) || !next.tenants.includes(next.scope.tenantId))
                throw new PlatformError('INCOMPATIBLE', 'Bootstrap scope does not match the requested tenant');
            const nextSignature = JSON.stringify(next);
            sessionKnown = true;
            requestedTenant = next.scope.tenantId;
            // Keep the accepted immutable instance on unchanged refreshes; do not invalidate its clients.
            if (force || needsRender || !bootstrap || nextSignature !== signature) {
                bootstrap = next;
                signature = nextSignature;
                renderShell();
            }
        }
        catch (e) {
            if (!controller.signal.aborted && epoch === refreshEpoch && !stopped)
                accessFailure(e);
        }
        finally {
            if (epoch === refreshEpoch)
                refreshing = false;
        }
    }
    const suspend = () => {
        if (stopped || suspended) return;
        suspended = true;
        bootstrapAbort?.abort();
        refreshEpoch++;
        sessionKnown = false;
        invalidateScope();
        content = undefined;
        noticeArea = undefined;
        root.replaceChildren(el('p', 'muted', 'Workspace paused. Reopen the app to check access.'));
    };
    const resume = () => {
        if (stopped || !suspended) return;
        suspended = false;
        if (logoutInProgress) {
            root.replaceChildren(el('p', 'muted', 'Signing out…'));
            content = undefined;
            noticeArea = undefined;
            return;
        }
        if (loggedOut) {
            renderLogin();
            return;
        }
        root.replaceChildren(el('p', 'muted', 'Checking access…'));
        content = undefined;
        noticeArea = undefined;
        void refresh(true);
    };
    const unbindLifecycle = lifecycle?.bind({ suspend, resume });
    const hash = () => { if (!suspended) void mountSelected(); };
    window.addEventListener('hashchange', hash);
    const timer = setInterval(() => { if (sessionKnown)
        void refresh(); }, 15000);
    void refresh();
    return () => { stopped = true; unbindLifecycle?.(); bootstrapAbort?.abort(); refreshEpoch++; clearInterval(timer); window.removeEventListener('hashchange', hash); invalidateScope(); root.replaceChildren(); };
}
