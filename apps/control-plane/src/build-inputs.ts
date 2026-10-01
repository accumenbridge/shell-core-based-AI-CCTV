import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOTS = new Set(['apps','modules','packages','products','solutions','tools','profiles','templates','visual']);
const ROOT_FILES = new Set(['package.json','package-lock.json','tsconfig.base.json']);
const EXCLUDED = new Set(['.git','.brain','.codex','analysis','artifacts','.artifacts','coverage','dist','evidence','exports','generated','node_modules','reference','test-results','__pycache__','.local']);
const SECRET = (name: string) => /^\.env(?:\.|$)/i.test(name) || /(?:^|[._-])(private|secret|credential|token)(?:[._-]|$)/i.test(name) || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(name);
const PORTABLE = (path: string) => path.split('/').every(part => Boolean(part) && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f:]/.test(part) && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

const TOOL_FILES = new Set(['build-host-preflight.ps1','build-job.ps1','build.mjs','build-visual.mjs','demo.mjs','factory.mjs','frontend-closure.mjs','link-workspaces.mjs','local-profile.mjs','studio-catalogue.mjs']);
const TEMPLATE_FILES = new Set(['module-backend.ts.txt','module-ui.ts.txt']);
const STATIC_WEB_FILES = new Set(['index.html','studio.css']);
function declaredModuleAssets(root: string): Set<string> {
  const assets = new Set<string>(), moduleRoot = join(root,'modules');
  if (!existsSync(moduleRoot)) return assets;
  for (const entry of readdirSync(moduleRoot,{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(moduleRoot,entry.name,'module.json');
    if (!existsSync(manifestPath)) continue;
    const info = lstatSync(manifestPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Module manifest must be a regular reviewed file');
    const manifest = JSON.parse(readFileSync(manifestPath,'utf8')) as {browserAssets?: unknown};
    if (!Array.isArray(manifest.browserAssets)) continue;
    for (const asset of manifest.browserAssets) {
      if (typeof asset !== 'string' || !asset || asset.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f\x7f]/.test(part))) throw new Error('Invalid declared module asset path');
      assets.add('modules/' + entry.name + '/src/' + asset);
    }
  }
  return assets;
}
function included(relativePath: string, directory: boolean, moduleAssets: Set<string>) {
  const parts = relativePath.replaceAll('\\','/').split('/').filter(Boolean);
  if (!directory && /\.tsbuildinfo$/i.test(parts.at(-1) ?? '')) return false;
  if (parts.some(part => EXCLUDED.has(part.toLowerCase()))) return false;
  if (relativePath.replaceAll('\\','/') === 'visual/data.json') return false;
  if (parts.length === 1) return directory ? ROOTS.has(parts[0]!) : ROOT_FILES.has(parts[0]!);
  const top = parts[0]!, leaf = parts.at(-1)!;
  if (!ROOTS.has(top)) return false;
  if (!PORTABLE(relativePath)) throw new Error('Non-portable build input path: ' + relativePath);
  if (parts.some(SECRET)) throw new Error('Sensitive or unreviewed build input is not accepted: ' + relativePath);
  if (['apps','packages','modules'].includes(top)) {
    if (parts.length === 2) return directory;
    if (parts.length === 3 && !directory && (leaf === 'package.json' || leaf === 'tsconfig.json' || (top === 'modules' && leaf === 'module.json'))) return true;
    if (parts[2] === 'src') {
      if (directory) return true;
      if (/\.ts$/i.test(leaf)) return true;
      if (top === 'modules' && moduleAssets.has(relativePath.replaceAll('\\','/'))) return true;
      if (top === 'packages' && parts[1] === 'web-shell' && relativePath === 'packages/web-shell/src/shell.css') return true;
    }
    if (top === 'apps' && parts[1] === 'studio-web' && parts[2] === 'static') {
      if (directory) return true;
      if (parts.length === 4 && STATIC_WEB_FILES.has(leaf)) return true;
    }
  } else if (top === 'products' || top === 'solutions') {
    if (parts.length === 2) return directory && /^[a-z][a-z0-9-]{1,47}$/.test(leaf);
    if (parts.length === 3 && !directory && ((top === 'products' && leaf === 'product.json') || (top === 'solutions' && (leaf === 'solution.json' || leaf === 'wiring.mjs')))) return true;
  } else if (top === 'tools') {
    if (parts.length === 2 && (leaf === 'registry-publish.ps1' || leaf === 'runtime-recovery-publish.ps1' || leaf === 'runtime-recovery.mjs' || leaf === 'runtime-supervisor.mjs')) return false;
    if (parts.length === 2 && !directory && TOOL_FILES.has(leaf)) return true;
    if (directory || /\.(?:json|csv|env|pem|key|p12|pfx|sqlite|db|log|txt|ps1)$/i.test(leaf)) throw new Error('Unreviewed or data-bearing tool input is not allowed: ' + relativePath);
    return false;
  }
  else if (top === 'templates' && parts.length === 2 && !directory && TEMPLATE_FILES.has(leaf)) return true;
  else if (top === 'profiles' && parts.length === 2 && !directory && leaf === 'local-developer.json') return true;
  else if (top === 'visual' && parts.length === 2 && !directory && ['studio.css','studio.js'].includes(leaf)) return true;
  throw new Error('Unreviewed build input path is not allowed: ' + relativePath);
}
/** Explicit reviewed build closure, with generated Studio/TypeScript outputs excluded. */
export function reviewedBuildFiles(root: string): { fullPath: string; relativePath: string }[] {
  if (lstatSync(root).isSymbolicLink()) throw new Error('Build source root cannot be a junction or symbolic link');
  const moduleAssets = declaredModuleAssets(root);
  const files: { fullPath: string; relativePath: string }[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const fullPath = join(dir,entry.name), relativePath = relative(root,fullPath).replaceAll('\\','/');
      const stat = lstatSync(fullPath);
      const parts=relativePath.split('/');
      if(ROOTS.has(parts[0]!)&&!parts.some(part=>EXCLUDED.has(part.toLowerCase()))){
        if(!PORTABLE(relativePath))throw new Error('Non-portable build input path: '+relativePath);
        if(stat.isSymbolicLink())throw new Error('Build source links are not accepted: '+relativePath);
      }
      if (!included(relativePath,stat.isDirectory(),moduleAssets)) continue;
      if (stat.isDirectory()) visit(fullPath);
      else if (stat.isFile()) files.push({fullPath,relativePath});
      else throw new Error(`Build input is not a regular file: ${relativePath}`);
    }
  };
  visit(root);
  const folded = files.map(file => file.relativePath.toLowerCase());
  if (new Set(folded).size !== folded.length) throw new Error('Build source has case-folded path collisions');
  return files;
}

export function reviewedBuildFingerprint(root: string): string {
  const hash = createHash('sha256');
  for (const file of reviewedBuildFiles(root)) { hash.update(file.relativePath); hash.update('\0'); hash.update(readFileSync(file.fullPath)); }
  return hash.digest('hex');
}

export async function copyReviewedBuildInputs(root: string,destination: string): Promise<void> {
  const before = reviewedBuildFingerprint(root);
  const files = reviewedBuildFiles(root);
  for (const file of files) {
    const output = join(destination,...file.relativePath.split('/'));
    await mkdir(dirname(output),{recursive:true});
    await copyFile(file.fullPath,output);
  }
  if (before !== reviewedBuildFingerprint(root) || before !== reviewedBuildFingerprint(destination)) throw new Error('Reviewed source changed during its private copy');
}

async function completeTreeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(dir: string) {
    const entries = await readdir(dir,{withFileTypes:true}); entries.sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const full=join(dir,entry.name), relativePath=relative(root,full).replaceAll('\\','/'), info=await lstat(full);
      if(info.isSymbolicLink())throw new Error(`Private toolchain link refused: ${relativePath}`);
      if(info.isDirectory())await visit(full);
      else if(info.isFile()){hash.update(relativePath);hash.update('\0');hash.update(await readFile(full));}
      else throw new Error(`Private toolchain entry is not a regular file: ${relativePath}`);
    }
  }
  await visit(root); return hash.digest('hex');
}

export async function privateToolchainDigest(root: string): Promise<string> {
  const rootPackage=JSON.parse(await readFile(join(root,'package.json'),'utf8')) as any;
  const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8')) as any;
  const names=['typescript','@types/node','undici-types'], hash=createHash('sha256');
  const nodeHash=sha(await readFile(process.execPath));
  hash.update(process.version);hash.update('\0');hash.update(nodeHash);
  for(const name of names){
    const packagePath=name==='@types/node'?'node_modules/@types/node':`node_modules/${name}`;
    const installed=JSON.parse(await readFile(join(root,packagePath,'package.json'),'utf8')) as any;
    const locked=lock.packages?.[packagePath]?.version;
    const spec=name==='undici-types'?lock.packages?.['node_modules/@types/node']?.dependencies?.['undici-types']:rootPackage.devDependencies?.[name];
    if(typeof installed.version!=='string'||installed.version!==locked||typeof spec!=='string'||spec.replace(/^[^0-9]*/,'')!==locked)throw new Error(`Installed compiler package ${name} does not match the pinned lockfile`);
    hash.update(name);hash.update('\0');hash.update(locked);hash.update('\0');hash.update(await completeTreeDigest(join(root,packagePath)));
  }
  return hash.digest('hex');
}

export async function copyPrivateToolchain(root: string,destination: string): Promise<void> {
  for(const name of ['typescript','@types/node','undici-types']){
    const packagePath=name==='@types/node'?'node_modules/@types/node':`node_modules/${name}`;
    const source=join(root,packagePath), target=join(destination,packagePath);
    async function copy(dir: string,out: string){
      const info=await lstat(dir);if(info.isSymbolicLink())throw new Error(`Private toolchain link refused: ${packagePath}`);
      if(info.isDirectory()){await mkdir(out,{recursive:true});for(const entry of await readdir(dir,{withFileTypes:true}))await copy(join(dir,entry.name),join(out,entry.name));}
      else if(info.isFile()){await mkdir(dirname(out),{recursive:true});await copyFile(dir,out);}
      else throw new Error(`Private toolchain entry is not a regular file: ${packagePath}`);
    }
    await copy(source,target);
  }
}
