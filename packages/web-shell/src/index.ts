import { PlatformError, validateProductExperience, type Actor, type ProductExperience, type Scope, type Workspace, type WorkspaceContext, type WorkspaceNavigationInput, type WorkspaceRouteContext } from '@quadbridge/contracts';
import { createScopedWorkspaceApi, requestJson, type RequestTransport } from '@quadbridge/client-core';
import { applyUiBoundary } from '@quadbridge/ui';
import { UI_CONTRIBUTION_SLOTS, type UiContribution, type UiContributionBinding, type UiContributionContext, type UiContributionDescriptor, type UiContributionSlot } from '@quadbridge/contracts/ui-contributions';
import { el, button, field } from './dom.js';
import { createWorkspaceNavigation, type WorkspaceNavigationController } from './navigation.js';
export interface ShellSnapshot {
    scope: Scope;
    actor: Actor;
    tenants: string[];
    permissions: string[];
    product: {
        id: string;
        title: string;
        description: string;
        layout: string;
        version: string;
        experience?: ProductExperience;
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
    onNavigate(routeId: string, input?: WorkspaceNavigationInput): Promise<boolean>;
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
    /** Fixed caller-owned transport; omitted for the existing same-origin web session. */
    request?: RequestTransport;
    presentation?: ShellPresentation;
    lifecycle?: ShellLifecyclePort;
    /** Fixed source-validated product presentation supplied by the selected build before login. */
    experience?: ProductExperience;
}
/** A native adapter may return to sign-in only after it has removed its local credential. */
export interface NativeLogoutOutcome {
    kind: 'quadbridge.native-logout.v1';
    remoteRevocation: 'confirmed' | 'unknown';
    localCredentials: 'removed' | 'unresolved';
    recovery: 'return-to-sign-in' | 'retry-local-cleanup';
}
function isNativeLogoutOutcome(value: unknown): value is NativeLogoutOutcome {
    if (!value || typeof value !== 'object') return false;
    const result = value as Partial<NativeLogoutOutcome>;
    return result.kind === 'quadbridge.native-logout.v1' &&
        (result.remoteRevocation === 'confirmed' || result.remoteRevocation === 'unknown') &&
        (result.localCredentials === 'removed' || result.localCredentials === 'unresolved') &&
        ((result.localCredentials === 'removed' && result.recovery === 'return-to-sign-in') ||
            (result.localCredentials === 'unresolved' && result.recovery === 'retry-local-cleanup'));
}
function applyExperienceBoundary(root: HTMLElement, experience?: ProductExperience) {
    applyUiBoundary(root, experience?.theme);
    root.setAttribute('data-qb-ui-host', '');
}
function gateWorkspaceApi(api: WorkspaceContext['api'], available: () => boolean): WorkspaceContext['api'] {
    const assertAvailable = () => { if (!available()) throw new DOMException('Workspace access is paused until session access is revalidated', 'AbortError'); };
    return Object.freeze({
        get: async (path: string, signal?: AbortSignal) => { assertAvailable(); return api.get(path, signal); },
        post: async (path: string, body: unknown, commandId?: string, signal?: AbortSignal) => { assertAvailable(); return api.post(path, body, commandId, signal); }
    });
}
function workspacePresentation(snapshot: ShellSnapshot): { workspace: ShellSnapshot['workspaces'][number]; routeId: string; label: string; order: number; mobilePriority: number }[] {
    const experience = snapshot.product.experience;
    if (!experience) return snapshot.workspaces.map((workspace, index) => ({ workspace, routeId: workspace.id, label: workspace.label, order: index, mobilePriority: index }));
    return experience.navigation.map(item => {
        const workspace = snapshot.workspaces.find(candidate => candidate.id === item.workspaceId);
        return workspace ? { workspace, routeId: item.id, label: item.label, order: item.order, mobilePriority: item.mobilePriority } : undefined;
    }).filter((item): item is NonNullable<typeof item> => !!item).sort((a, b) => a.order - b.order || a.routeId.localeCompare(b.routeId));
}
function renderDesktopPresentation({ root, snapshot: snap, onTenantChange, onSignOut, onNavigate }: ShellPresentationOptions): ShellPresentationElements {
    applyExperienceBoundary(root, snap.product.experience);
    const shell = el('div', `shell ${snap.product.layout === 'top' ? 'top-layout' : ''}`), side = el('aside', 'sidebar');
    const brand = el('div', 'brand-row');
    brand.append(el('span', 'brand-symbol', snap.product.experience?.brand.name.slice(0, 1).toUpperCase() ?? 'Q'), el('span', 'brand', snap.product.experience?.brand.name ?? 'Quadbridge'));
    side.append(brand, el('span', 'eyebrow product-eyebrow', 'PRODUCT WORKSPACE'), el('span', 'product-name', snap.product.title), el('p', 'muted small', snap.product.description));
    const nav = el('nav');
    nav.setAttribute('aria-label', 'Workspaces');
    for (const item of workspacePresentation(snap)) {
        const link = el('a', 'nav-item', item.label);
        link.setAttribute('data-workspace-path', item.workspace.path);
        link.href = `#${item.workspace.path}`;
        link.addEventListener('click', event => { event.preventDefault(); void onNavigate(item.routeId); });
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
export function startShell({ root, title, loaders, uiBindings = [], request: requestTransport, presentation = renderDesktopPresentation, lifecycle, experience: configuredExperience }: ShellOptions) {
    let productExperience = configuredExperience === undefined ? undefined : validateProductExperience(configuredExperience);
    let bootstrap: Bootstrap | undefined, requestedTenant: string | undefined;
    let generation = 0, active: AbortController | undefined, cleanup: (() => void) | undefined;
    let contributionSlots: ShellPresentationElements['contributionSlots'], contributionLayout: HTMLElement | undefined;
    let contributionControllers: AbortController[] = [], contributionCleanups: (() => void)[] = [];
    let shellNavigation: WorkspaceNavigationController | undefined, activeRoute: WorkspaceRouteContext | undefined;
    let mountedWorkspaceId: string | undefined;
    const providerNavigationDisposers: (() => void)[] = [];
    let bootstrapAbort: AbortController | undefined, refreshEpoch = 0, refreshing = false;
    let content: HTMLElement | undefined, noticeArea: HTMLElement | undefined;
    let stopped = false, suspended = false, resumePending = false, logoutInProgress = false, logoutUnresolved = false, logoutRetryLocalOnly = false, logoutRecoveryMessage = 'The server did not confirm sign-out. Retry to reconcile this session.', logoutRecoveryLabel = 'Retry sign out', loggedOut = false, logoutNotice: string | undefined, signature = '', sessionKnown = false, needsRender = true;
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
        mountedWorkspaceId = undefined;
        for (const dispose of providerNavigationDisposers.splice(0).reverse()) { try { dispose(); } catch { /* provider cleanup remains isolated */ } }
        clearContributionViews();
        content?.replaceChildren();
    }
    function disposeShellNavigation() {
        shellNavigation?.dispose();
        shellNavigation = undefined;
        activeRoute = undefined;
    }
    function scopedNavigation(controller: WorkspaceNavigationController, isCurrent: () => boolean): NonNullable<WorkspaceContext['navigation']> {
        const retain = (dispose: () => void) => {
            let live = true;
            const release = () => { if (!live) return; live = false; dispose(); };
            providerNavigationDisposers.push(release);
            return release;
        };
        return Object.freeze({
            current: () => controller.port.current(),
            subscribe: (listener: (route: WorkspaceRouteContext) => void) => retain(controller.port.subscribe(route => { if (isCurrent()) listener(route); })),
            navigate: (routeId: string, input?: WorkspaceNavigationInput) => isCurrent() ? controller.port.navigate(routeId, input) : Promise.resolve(false),
            registerUnsavedGuard: (guard: (route: WorkspaceRouteContext) => boolean | Promise<boolean>) => retain(controller.port.registerUnsavedGuard(route => isCurrent() ? guard(route) : false))
        });
    }
    function invalidateScope() {
        disposeShellNavigation();
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
    const request: RequestTransport = (path, init = {}, signal, tenantId) => (requestTransport ?? requestJson)(path, init, signal, tenantId);
    function renderLogin() {
        invalidateScope();
        root.replaceChildren();
        applyExperienceBoundary(root, productExperience);
        content = undefined;
        noticeArea = undefined;
        contributionSlots = undefined;
        contributionLayout = undefined;
        const welcome = el('section', 'login-story');
        const monogram = el('div', 'brand-symbol', 'Q');
        welcome.append(monogram, el('span', 'eyebrow', productExperience?.brand.name ?? 'QUADBRIDGE PRODUCT PLATFORM'), el('h2', '', productExperience?.login.title ?? 'One foundation.\nYour next product.'), el('p', 'muted', productExperience?.login.description ?? 'A shared application shell. Your selected modules. Separate business ownership.'));
        const stack = el('div', 'foundation-stack');
        for (const [name, detail] of [['Web shell', 'Session · navigation · workspace'], ['Product modules', 'Your operations and business rules'], ['Owner stores', 'Scoped records and durable receipts']]) {
            const row = el('div', 'foundation-layer');
            row.append(el('span', 'layer-symbol', '◇'), el('strong', '', name), el('span', 'small muted', detail));
            stack.append(row);
        }
        welcome.append(stack, el('p', 'small muted', 'LOCAL DEVELOPER PROFILE · No cloud account required'));
        const loginLayout = el('div', 'login-layout');
        const card = el('main', 'login-card');
        card.append(el('span', 'eyebrow', productExperience?.brand.name ?? 'QUADBRIDGE / PRODUCT PLATFORM'), el('h1', '', productExperience?.login.title ?? title), el('p', 'muted', productExperience?.login.help ?? 'Local developer profile. Use the credentials generated by the launcher.'));
        const form = el('form'), name = field('Username', 'username'), password = field('Password', 'password');
        password.input.setAttribute('type', 'password');
        password.input.setAttribute('autocomplete', 'current-password');
        name.input.setAttribute('autocomplete', 'username');
        const error = el('p', 'error');
        error.setAttribute('role', 'alert');
        if (logoutNotice) error.textContent = logoutNotice;
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
                logoutNotice = undefined;
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
    function renderLogoutRecovery(message: string, retryLabel: string, retryLocalOnly = false) {
        if (stopped || suspended) return;
        root.replaceChildren();
        content = el('main', 'login-card');
        content.append(el('span', 'eyebrow', 'SESSION RECOVERY'), el('h1', '', 'Sign-out unresolved'), el('p', 'muted', message),
            button(retryLabel, () => { void performLogout(retryLocalOnly); }));
        root.append(content);
        noticeArea = undefined;
        contributionSlots = undefined;
        contributionLayout = undefined;
    }
    async function performLogout(retryLocalOnly = false) {
        if (logoutInProgress || stopped) return;
        logoutInProgress = true;
        logoutUnresolved = false;
        logoutRetryLocalOnly = retryLocalOnly;
        loggedOut = false;
        bootstrapAbort?.abort();
        refreshEpoch++;
        sessionKnown = false;
        invalidateScope();
        root.replaceChildren(el('p', 'muted', retryLocalOnly ? 'Removing saved sign-in…' : 'Signing out…'));
        content = undefined;
        noticeArea = undefined;
        contributionSlots = undefined;
        contributionLayout = undefined;
        try {
            const result = await request('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (result && typeof result === 'object' && (result as { signedOut?: unknown }).signedOut === true) {
                logoutInProgress = false;
                loggedOut = true;
                logoutRetryLocalOnly = false;
                logoutNotice = undefined;
                requestedTenant = undefined;
                if (!stopped && !suspended) renderLogin();
                return;
            }
            if (isNativeLogoutOutcome(result)) {
                if (result.localCredentials === 'removed') {
                    logoutInProgress = false;
                    loggedOut = true;
                    logoutNotice = result.remoteRevocation === 'confirmed' ? undefined :
                        'This device removed its saved sign-in, but the server could not confirm that the session was revoked.';
                    requestedTenant = undefined;
                    if (!stopped && !suspended) renderLogin();
                    return;
                }
                logoutInProgress = false;
                logoutUnresolved = true;
                logoutNotice = undefined;
                const message = result.remoteRevocation === 'confirmed'
                    ? 'The server confirmed sign-out, but this device has not confirmed removal of its saved sign-in.'
                    : 'Neither server revocation nor removal of this device’s saved sign-in is confirmed.';
                logoutRetryLocalOnly = true;
                logoutRecoveryMessage = message;
                logoutRecoveryLabel = 'Retry local credential cleanup';
                if (!stopped && !suspended) renderLogoutRecovery(message, 'Retry local credential cleanup', true);
                return;
            }
            logoutInProgress = false;
            logoutUnresolved = true;
            logoutRetryLocalOnly = false;
            logoutNotice = undefined;
            logoutRecoveryMessage = 'The server did not confirm sign-out. Retry to reconcile this session.';
            logoutRecoveryLabel = 'Retry sign out';
            if (!stopped && !suspended) renderLogoutRecovery(logoutRecoveryMessage, logoutRecoveryLabel);
        }
        catch {
            logoutInProgress = false;
            logoutUnresolved = true;
            logoutRetryLocalOnly = false;
            logoutNotice = undefined;
            logoutRecoveryMessage = 'The server did not confirm sign-out. Retry to reconcile this session.';
            logoutRecoveryLabel = 'Retry sign out';
            if (!stopped && !suspended) renderLogoutRecovery(logoutRecoveryMessage, logoutRecoveryLabel);
        }
    }
    async function mountContributions(selected: ShellSnapshot['workspaces'][number], snap: Bootstrap, parent: AbortController, current: () => boolean, available: () => boolean) {
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
            const scoped = gateWorkspaceApi(createScopedWorkspaceApi({
                operations: snap.operations,
                moduleId: descriptor.moduleId,
                tenantId: snap.scope.tenantId,
                signal: controller.signal,
                isCurrent: contributionCurrent,
                origin: () => location.origin,
                onAccessFailure: accessFailure,
                request
            }), () => available() && contributionCurrent());
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
                    notice: message => { if (available() && contributionCurrent()) notice(message); }
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
    function setCurrentWorkspace(snap: Bootstrap, route: WorkspaceRouteContext) {
        const workspace = snap.workspaces.find(item => item.id === route.workspaceId);
        const path = workspace?.path;
        for (const anchor of Array.from(root.querySelectorAll?.('[data-workspace-path]') ?? []))
            anchor.setAttribute('aria-current', anchor.getAttribute('data-workspace-path') === path ? 'page' : 'false');
    }
    function showRouteRecovery() {
        if (!bootstrap || !content || stopped) return;
        const first = workspacePresentation(bootstrap)[0];
        if (mountedWorkspaceId !== undefined && active && !active.signal.aborted) {
            const status = el('div', 'notice route-recovery');
            status.setAttribute('role', 'status');
            status.append(el('span', '', 'This URL is not an available product route. The current workspace and its unsaved work are still open.'));
            if (first) status.append(button('Return to an available workspace', () => { void shellNavigation?.port.navigate(first.routeId); }));
            if (!content.querySelector('.route-recovery')) content.prepend(status);
            return;
        }
        clearView();
        activeRoute = undefined;
        content.append(el('h2', '', 'This page is unavailable'), el('p', 'muted', 'The route is not part of this product or is not available to your current workspace. Choose an available workspace to continue.'));
        if (first) content.append(button('Go to an available workspace', () => { void shellNavigation?.port.navigate(first.routeId); }));
    }
    async function mountSelected(requestedRoute?: WorkspaceRouteContext) {
        // A hash event during a scope replacement cannot use the obsolete bootstrap.
        if (!bootstrap || stopped || suspended || logoutInProgress || !content)
            return;
        const route = requestedRoute ?? shellNavigation?.port.current();
        if (!route) { showRouteRecovery(); return; }
        if (mountedWorkspaceId === route.workspaceId && active && !active.signal.aborted) {
            activeRoute = route;
            setCurrentWorkspace(bootstrap, route);
            return;
        }
        clearView();
        activeRoute = route;
        const ownGeneration = generation, controller = new AbortController();
        active = controller;
        const snap = bootstrap;
        const live = () => !stopped && !controller.signal.aborted && ownGeneration === generation && bootstrap === snap;
        const current = () => live() && !suspended && !resumePending;
        setCurrentWorkspace(snap, route);
        const selected = snap.workspaces.find(w => w.id === route.workspaceId);
        if (!selected && snap.modules.length) {
            content.append(el('h2', '', 'Choose an available workspace'), el('p', 'muted', 'This route is not selected or not permitted. Use the workspace navigation.'));
            return;
        }
        if (!selected) {
            mountedWorkspaceId = route.workspaceId;
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
        const workspaceLayout = snap.product.experience?.layoutByWorkspace.find(item => item.workspaceId === selected.id)?.mode;
        if (workspaceLayout) stage.setAttribute('data-qb-layout-mode', workspaceLayout);
        content.append(stage);
        stage.append(el('p', 'muted', 'Opening workspace…'));
        try {
            const loaded = await loader();
            if (!live())
                return;
            const provider = Object.hasOwn(loaded, selected.export) ? loaded[selected.export] as Workspace | undefined : undefined;
            if (!provider || typeof provider.mount !== 'function')
                throw new PlatformError('INCOMPATIBLE', `Workspace export ${selected.export} is unavailable`);
            stage.replaceChildren();
            const api = gateWorkspaceApi(createScopedWorkspaceApi({
                operations: snap.operations,
                moduleId: selected.moduleId,
                tenantId: snap.scope.tenantId,
                signal: controller.signal,
                isCurrent: live,
                origin: () => location.origin,
                onAccessFailure: accessFailure,
                request
            }), current);
            const contextNavigation = shellNavigation;
            const ctx: WorkspaceContext = {
                root: stage, scope: Object.freeze({ ...snap.scope }), actor: Object.freeze({ ...snap.actor }), signal: controller.signal, locale: 'en', permissions: Object.freeze([...snap.permissions]),
                notice: message => { if (current())
                    notice(message); },
                api,
                route,
                navigation: shellNavigation ? scopedNavigation(shellNavigation, current) : undefined
            };
            Object.defineProperty(ctx, 'route', { enumerable: true, configurable: false, get: () => current() ? contextNavigation?.port.current() : undefined });
            cleanup = provider.mount(ctx) || undefined;
            mountedWorkspaceId = route.workspaceId;
            await mountContributions(selected, snap, controller, live, current);
        }
        catch (e) {
            if (live()) {
                mountedWorkspaceId = undefined;
                stage.replaceChildren(el('h2', '', 'Workspace unavailable'), el('p', 'muted', e instanceof Error ? e.message : 'Provider failed'), button('Try again', () => void mountSelected()));
            }
        }
    }
    function renderShell() {
        if (!bootstrap)
            return;
        applyExperienceBoundary(root, bootstrap.product.experience);
        disposeShellNavigation();
        clearView();
        needsRender = false;
        const snap = bootstrap;
        const navigableWorkspaceIds = snap.product.experience ? new Set(snap.product.experience.navigation.map(item => item.workspaceId)) : undefined;
        const navigableWorkspaces = navigableWorkspaceIds ? snap.workspaces.filter(item => navigableWorkspaceIds.has(item.id)) : snap.workspaces;
        shellNavigation = createWorkspaceNavigation({
            workspaces: navigableWorkspaces,
            experience: snap.product.experience,
            canNavigate: () => !stopped && !suspended && !resumePending && !logoutInProgress && !logoutUnresolved && !loggedOut,
            onRoute: (next, previous) => {
                activeRoute = next;
                content?.querySelector?.('.route-recovery')?.remove();
                setCurrentWorkspace(snap, next);
                if (previous.workspaceId === next.workspaceId && mountedWorkspaceId === next.workspaceId) return;
                return mountSelected(next);
            },
            onInvalidRoute: showRouteRecovery,
            onGuardError: () => notice('The page could not be changed because unsaved work needs attention.')
        });
        const view = presentation({
            root,
            snapshot: snap,
            onNavigate: (routeId, input) => shellNavigation?.port.navigate(routeId, input) ?? Promise.resolve(false),
            onTenantChange: tenantId => {
                if (stopped || !snap.tenants.includes(tenantId)) return;
                requestedTenant = tenantId;
                invalidateScope();
                notice('Loading authorized tenant context…');
                void refresh(true);
            },
            onSignOut: () => { void performLogout(); }
        });
        content = view.content;
        noticeArea = view.noticeArea;
        contributionSlots = view.contributionSlots;
        contributionLayout = view.contributionLayout;
        if (!shellNavigation.initialValid) showRouteRecovery();
        else void mountSelected(shellNavigation.port.current());
    }
    async function refresh(force = false) {
        if (stopped || suspended || logoutInProgress || logoutUnresolved || loggedOut || (refreshing && !force))
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
            const receivedExperience = next.product?.experience;
            if (productExperience && !receivedExperience) throw new PlatformError('INCOMPATIBLE', 'Bootstrap omitted the selected product presentation');
            if (productExperience && receivedExperience && JSON.stringify(validateProductExperience(receivedExperience)) !== JSON.stringify(productExperience)) throw new PlatformError('INCOMPATIBLE', 'Bootstrap product presentation does not match this fixed build');
            if (!productExperience && receivedExperience) productExperience = validateProductExperience(receivedExperience);
            if (productExperience && receivedExperience) next.product = { ...next.product, experience: productExperience };
            if (!next.scope || (requested && next.scope.tenantId !== requested) || !next.tenants.includes(next.scope.tenantId))
                throw new PlatformError('INCOMPATIBLE', 'Bootstrap scope does not match the requested tenant');
            const nextSignature = JSON.stringify(next);
            const revealAfterResume = resumePending;
            resumePending = false;
            sessionKnown = true;
            requestedTenant = next.scope.tenantId;
            // Keep the accepted immutable instance on unchanged refreshes; do not invalidate its clients.
            if (needsRender || !bootstrap || nextSignature !== signature) {
                bootstrap = next;
                signature = nextSignature;
                renderShell();
            }
            if (revealAfterResume) root.hidden = false;
        }
        catch (e) {
            if (!controller.signal.aborted && epoch === refreshEpoch && !stopped) {
                resumePending = false;
                root.hidden = false;
                accessFailure(e);
            }
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
        resumePending = true;
        if (!bootstrap && !active) {
            root.replaceChildren(el('p', 'muted', 'Workspace paused. Reopen the app to check access.'));
            content = undefined;
            noticeArea = undefined;
            contributionSlots = undefined;
            contributionLayout = undefined;
        }
        root.hidden = true;
    };
    const resume = () => {
        if (stopped || !suspended) return;
        suspended = false;
        if (logoutInProgress) {
            root.hidden = false;
            root.replaceChildren(el('p', 'muted', 'Signing out…'));
            content = undefined;
            noticeArea = undefined;
            return;
        }
        if (logoutUnresolved) {
            root.hidden = false;
            renderLogoutRecovery(logoutRecoveryMessage, logoutRecoveryLabel, logoutRetryLocalOnly);
            return;
        }
        if (loggedOut) {
            root.hidden = false;
            renderLogin();
            return;
        }
        root.hidden = true;
        void refresh(true);
    };
    const unbindLifecycle = lifecycle?.bind({ suspend, resume });
    const timer = setInterval(() => { if (sessionKnown)
        void refresh(); }, 15000);
    void refresh();
    return () => { stopped = true; unbindLifecycle?.(); bootstrapAbort?.abort(); refreshEpoch++; clearInterval(timer); invalidateScope(); root.replaceChildren(); };
}
