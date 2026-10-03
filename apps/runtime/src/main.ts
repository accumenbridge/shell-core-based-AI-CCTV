import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRuntime } from './index.js';
import { canonical } from '@quadbridge/contracts';
const args = process.argv.slice(2);
const value = (key: string, fallback?: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : fallback; };
if (args.includes('--mobile-preview') && args.includes('--worker'))
    throw new Error('--mobile-preview is available only for the web runtime');
const nativeApiEnabled = args.includes('--native-api');
if (nativeApiEnabled && args.includes('--worker'))
    throw new Error('--native-api is available only for the web runtime');
const product = value('--product', 'neutral')!, configPath = value('--config');
const port = Number(value('--port', '4300'));
if (!args.includes('--worker') && (!Number.isSafeInteger(port) || port < 0 || port > 65535))
    throw new Error('Invalid port');
if (nativeApiEnabled && port === 4350)
    throw new Error('The web and native API ports must be different');
if (!configPath) {
    console.error('A local runtime config is required. Run npm run demo to create fresh local credentials and configs.');
    process.exit(2);
}
const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
if (!args.includes('--worker') && config.nativeApiProfile !== undefined && (config.nativeApiProfile === 'local-native-forwarded-v1') !== nativeApiEnabled)
    throw new Error('The fixed native API launch flag must match the captured runtime enrollment.');
if (config.nativeApiProfile !== undefined && config.nativeApiProfile !== 'local-native-forwarded-v1')
    throw new Error('The captured runtime contains an unsupported native API profile.');
const runtime = await createRuntime(product, config);
let shutdown: () => Promise<void>;
if (args.includes('--worker')) {
    if (!runtime.plan.requiresWorker) {
        await runtime.close();
        console.log('No worker capability selected.');
        process.exit(0);
    }
    const worker = await runtime.worker();
    const running = worker.run();
    shutdown = async () => { worker.stop(); await running; await runtime.close(); };
    console.log(JSON.stringify({ role: 'worker', product, instance: config.instanceId, state: 'READY' }));
}
else {
    const http = await runtime.http(port, { mobilePreview: args.includes('--mobile-preview') });
    let nativeUrl: string | undefined;
    try {
        if (nativeApiEnabled) nativeUrl = (await runtime.nativeHttp(4350)).url;
    } catch (error) {
        await http.close();
        await runtime.close();
        throw error;
    }
    shutdown = async () => { await http.close(); await runtime.close(); };
    const nativeApiIdentity = nativeUrl ? { productId: runtime.plan.product.id, productVersion: runtime.plan.product.version,
        instanceId: config.instanceId, planDigest: createHash('sha256').update(canonical(runtime.plan)).digest('hex'),
        modules: runtime.plan.modules.map(module => ({ id: module.id, version: module.version })) } : undefined;
    console.log(JSON.stringify({ role: 'web-backend', product, instance: config.instanceId, url: http.url,
        ...(nativeUrl ? { nativeApiUrl: nativeUrl, nativeApiProfile: 'local-native-forwarded-v1', nativeApiIdentity } : {}), state: 'READY' }));
}
let closing = false;
const stop = () => {
    if (closing)
        return;
    closing = true;
    void shutdown().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
