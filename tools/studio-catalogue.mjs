import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { resolve } from '../packages/composition/dist/index.js';
import { composeDraft, inspectProductDefinition, parseProductDefinition, previewProductDefinition, serializeProductDefinition, validateProduct } from '../packages/composition/dist/studio.js';
import { validateProductFamily } from '../packages/composition/dist/family.js';
import { validateStudioModule } from '../packages/studio-model/dist/index.js';

export { composeDraft, inspectProductDefinition, parseProductDefinition, previewProductDefinition, serializeProductDefinition, validateProduct };
export async function readCatalogue(root) {
    const collect = async (dir, filename, optionalRoot = false) => {
        const base = pathResolve(root, dir);
        let entries;
        try { entries = await readdir(base, { withFileTypes: true }); }
        catch (error) { if (optionalRoot && error?.code === 'ENOENT') return []; throw error; }
        const results = [];
        for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
            if (!entry.isDirectory()) continue;
            if (!/^[a-z][a-z0-9-]*$/.test(entry.name)) throw Error('Unsafe catalogue directory');
            const file=join(base,entry.name,filename);
            if (await realpath(file)!==file) throw Error('Catalogue files must not be symlinks');
            const text=await readFile(file,'utf8');
            if (text.length>131072) throw Error('Catalogue file exceeds budget');
            const parsed=JSON.parse(text);
            if (filename==='module.json') validateStudioModule(parsed);
            const value=filename==='family.json'?validateProductFamily(parsed):parsed;
            if (filename!=='package.json' && value.id!==entry.name) throw Error('Catalogue identity mismatch');
            results.push(value);
        }
        return results;
    };
    const [modules, products, solutions, families, packages, rootPackage] = await Promise.all([
        collect('modules','module.json'),collect('products','product.json'),collect('solutions','solution.json'),
        collect('families','family.json', true),collect('packages','package.json'),readFile(join(root,'package.json'),'utf8').then(JSON.parse)
    ]);
    const plans = Object.fromEntries(products.map(product=>{
        try { return [product.id,{valid:true,plan:resolve(product,modules)}]; }
        catch(e) { return [product.id,{valid:false,error:e.message}]; }
    }));
    return { modules, products, solutions, families, packages:packages.map(p=>({id:p.name.replace(/^@quadbridge\//,''),version:p.version})), plans, sourceVersion:rootPackage.version, studioVersion:'1.0' };
}

/** Bundle only these reviewed pure first-party modules. No second handwritten resolver. */
export async function browserCore(root) {
    const fixedImports = {
        'packages/contracts/dist/module-manifest.js': ["import { PLATFORM_ABI, PlatformError } from './index.js';"],
        'packages/contracts/dist/operations.js': ["import { PlatformError, canonical } from './index.js';"],
        'packages/contracts/dist/ui-contributions.js': ["import { PlatformError } from './index.js';"],
        'packages/contracts/dist/experience.js': ["import { PlatformError } from './index.js';"],
        'packages/composition/dist/index.js': [
            "import { PLATFORM_ABI, PlatformError, canonical, validateProductExperience } from '@quadbridge/contracts';",
            "import { validateModuleManifest } from '@quadbridge/contracts/module-manifest';",
            "import { validateOperationDescriptor } from '@quadbridge/contracts/operations';",
            "import { validateUiContributionDescriptors } from '@quadbridge/contracts/ui-contributions';"
        ],
        'packages/composition/dist/studio.js': [
            "import { PLATFORM_ABI, PlatformError, object, validSourceDirectoryId } from '@quadbridge/contracts';",
            "import { resolve } from './index.js';"
        ],
        'packages/composition/dist/family.js': [
            "import { resolve } from './index.js';",
            "import { composeDraft, validateProduct } from './studio.js';"
        ]
    };
    const build = async (path, name, imports, exports) => {
        let code = await readFile(join(root,path),'utf8');
        const supportedImports = fixedImports[path] ?? [];
        const importLines = code.split(/\r?\n/).filter(line => /^import\s/.test(line));
        if (importLines.length !== supportedImports.length || importLines.some(line => !supportedImports.includes(line))) throw Error('Unsupported browser-core module format');
        code = code.split(/\r?\n/).filter(line => !supportedImports.includes(line)).join('\n');
        if (path === 'packages/contracts/dist/index.js') {
            const lines = code.split(/\r?\n/);
            const uiStateReexports = lines.filter(line => line === "export * from './ui-state.js';");
            if (uiStateReexports.length !== 1) throw Error('Expected exactly one reviewed contracts UI-state re-export');
            const experienceReexports = lines.filter(line => line === "export * from './experience.js';");
            if (experienceReexports.length !== 1) throw Error('Expected exactly one reviewed contracts experience re-export');
            code = lines.filter(line => line !== "export * from './ui-state.js';" && line !== "export * from './experience.js';").join('\n');
        }
        code=code.replace(/\bexport (?=(?:const|function|class|let)\b)/g,'').replace(/^\/\/# sourceMappingURL=.*$/gm,'');
        if (/^(?:import|export)\s/m.test(code)) throw Error('Unsupported browser-core module format');
        return `globalThis.${name}=(()=>{\n${imports}\n${code}\nreturn {${exports}};\n})();\n`;
    };
    return await build('packages/contracts/dist/index.js','QBContracts','', 'PLATFORM_ABI,PlatformError,canonical,object,validSourceDirectoryId')+
        await build('packages/contracts/dist/experience.js','QBExperience','const {PlatformError}=globalThis.QBContracts;', 'PRODUCT_EXPERIENCE_SCHEMA,validateProductExperience')+
        'globalThis.QBContracts.PRODUCT_EXPERIENCE_SCHEMA=globalThis.QBExperience.PRODUCT_EXPERIENCE_SCHEMA;globalThis.QBContracts.validateProductExperience=globalThis.QBExperience.validateProductExperience;\n'+
        await build('packages/contracts/dist/module-manifest.js','QBModuleManifest','const {PLATFORM_ABI,PlatformError}=globalThis.QBContracts;', 'validateModuleManifest,EXACT_MODULE_VERSION')+
        await build('packages/contracts/dist/operations.js','QBOperations','const {PlatformError,canonical}=globalThis.QBContracts;', 'OPERATION_LIMITS,validateOperationDescriptor,validateOperationValue,sameOperationDescriptor')+
        await build('packages/contracts/dist/ui-contributions.js','QBUiContributions','const {PlatformError}=globalThis.QBContracts;', 'UI_CONTRIBUTION_SLOTS,validateUiContributionDescriptors,resolveUiContributionBindings')+
        await build('packages/composition/dist/index.js','QBComposition','const {PLATFORM_ABI,PlatformError,canonical,validateProductExperience}=globalThis.QBContracts;const {validateModuleManifest}=globalThis.QBModuleManifest;const {validateOperationDescriptor}=globalThis.QBOperations;const {validateUiContributionDescriptors}=globalThis.QBUiContributions;', 'resolve')+
        await build('packages/composition/dist/studio.js','QBComposer','const {PLATFORM_ABI,PlatformError,canonical,object,validSourceDirectoryId}=globalThis.QBContracts;const {resolve}=globalThis.QBComposition;', 'composeDraft,validateProduct,validProductId,inspectProductDefinition,parseProductDefinition,previewProductDefinition,serializeProductDefinition,STUDIO_PRODUCT_TEXT_LIMIT')+
        await build('packages/composition/dist/family.js','QBFamilies','const {resolve}=globalThis.QBComposition;const {composeDraft,validateProduct}=globalThis.QBComposer;', 'validateProductFamily,deriveFamily');
}
