import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { resolve } from '../packages/composition/dist/index.js';
import { composeDraft, inspectProductDefinition, parseProductDefinition, previewProductDefinition, serializeProductDefinition, validateProduct } from '../packages/composition/dist/studio.js';

export { composeDraft, inspectProductDefinition, parseProductDefinition, previewProductDefinition, serializeProductDefinition, validateProduct };
export async function readCatalogue(root) {
    const collect = async (dir, filename) => {
        const base = pathResolve(root, dir), entries = await readdir(base, { withFileTypes: true });
        const results = [];
        for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
            if (!entry.isDirectory()) continue;
            if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) throw Error('Unsafe catalogue directory');
            const file=join(base,entry.name,filename);
            if (await realpath(file)!==file) throw Error('Catalogue files must not be symlinks');
            const text=await readFile(file,'utf8');
            if (text.length>131072) throw Error('Catalogue file exceeds budget');
            const value=JSON.parse(text);
            if (filename!=='package.json' && value.id!==entry.name) throw Error('Catalogue identity mismatch');
            results.push(value);
        }
        return results;
    };
    const [modules, products, solutions, packages, rootPackage] = await Promise.all([
        collect('modules','module.json'),collect('products','product.json'),collect('solutions','solution.json'),collect('packages','package.json'),readFile(join(root,'package.json'),'utf8').then(JSON.parse)
    ]);
    const plans = Object.fromEntries(products.map(product=>{
        try { return [product.id,{valid:true,plan:resolve(product,modules)}]; }
        catch(e) { return [product.id,{valid:false,error:e.message}]; }
    }));
    return { modules, products, solutions, packages:packages.map(p=>({id:p.name.replace(/^@quadbridge\//,''),version:p.version})), plans, sourceVersion:rootPackage.version, studioVersion:'1.0' };
}

/** Bundle only these three pure, built first-party modules. No second handwritten resolver. */
export async function browserCore(root) {
    const build = async (path, name, imports, exports) => {
        let code = await readFile(join(root,path),'utf8');
        code=code.replace(/^import .*?;\s*$/gm,'').replace(/\bexport (?=(?:const|function|class|let)\b)/g,'').replace(/^\/\/# sourceMappingURL=.*$/gm,'');
        if (/^import |\bexport \{/m.test(code)) throw Error('Unsupported browser-core module format');
        return `globalThis.${name}=(()=>{\n${imports}\n${code}\nreturn {${exports}};\n})();\n`;
    };
    return await build('packages/contracts/dist/index.js','QBContracts','', 'PLATFORM_ABI,PlatformError,canonical,object')+
        await build('packages/composition/dist/index.js','QBComposition','const {PLATFORM_ABI,PlatformError,canonical}=globalThis.QBContracts;', 'resolve')+
        await build('packages/composition/dist/studio.js','QBComposer','const {PLATFORM_ABI,PlatformError,canonical,object}=globalThis.QBContracts;const {resolve}=globalThis.QBComposition;', 'composeDraft,validateProduct,validProductId,inspectProductDefinition,parseProductDefinition,previewProductDefinition,serializeProductDefinition,STUDIO_PRODUCT_TEXT_LIMIT');
}
