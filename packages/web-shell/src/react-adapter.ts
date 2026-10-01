import type { Workspace, WorkspaceContext } from '@quadbridge/contracts';
/** Integrates the application's installed React/ReactDOM, without making React a neutral-core dependency.
 * Pass createRoot from react-dom/client and a render callback returning a real React element.
 * This adapter's lifecycle is tested; the third-party React runtime is NOT included in the offline profile. */
export interface ReactRootPort {
    render(element: unknown): void;
    unmount(): void;
}
export function reactWorkspace(createRoot: (container: HTMLElement) => ReactRootPort, render: (ctx: WorkspaceContext) => unknown): Workspace {
    return { mount(ctx) {
            if (ctx.signal.aborted)
                return;
            const root = createRoot(ctx.root);
            let disposed = false;
            const dispose = () => {
                if (disposed)
                    return;
                disposed = true;
                ctx.signal.removeEventListener('abort', dispose);
                root.unmount();
            };
            ctx.signal.addEventListener('abort', dispose, { once: true });
            try {
                root.render(render(ctx));
            }
            catch (e) {
                dispose();
                throw e;
            }
            return dispose;
        } };
}
