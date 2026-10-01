/** Offline Studio: actual catalogues + compiled canonical composition code, no runtime privileges. */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readCatalogue, browserCore } from './studio-catalogue.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const data=await readCatalogue(root);
const safeJson=JSON.stringify(data).replaceAll('<','\\u003c');
const read=p=>readFile(join(root,p),'utf8');
const html=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Quadbridge · Visual Product Studio</title><style>${await read('visual/studio.css')}</style></head><body><div id="studio"><noscript>Enable JavaScript to use the visual studio. Run npm run studio for the authenticated local builder.</noscript></div><script>globalThis.QB_VISUAL_DATA=${safeJson};</script><script>${await browserCore(root)}</script><script>${await read('visual/studio.js')}</script></body></html>`;
await writeFile(join(root,'OPEN_PLATFORM.html'),html);
await writeFile(join(root,'visual/data.json'),JSON.stringify(data,null,2)+'\n');
console.log(`Built visual Studio from ${data.modules.length} actual modules and ${data.products.length} products. Offline mode makes no API calls.`);
