import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOTS = new Set(['apps','families','modules','packages','products','solutions','tools','profiles','templates','visual']);
const ROOT_FILES = new Set(['package.json','package-lock.json','tsconfig.base.json']);
const EXCLUDED = new Set(['.git','.brain','.codex','analysis','artifacts','.artifacts','coverage','dist','evidence','exports','generated','node_modules','reference','test-results','__pycache__','.local']);
const SECRET = (name: string) => /^\.env(?:\.|$)/i.test(name) || /(?:^|[._-])(private|secret|credential|token)(?:[._-]|$)/i.test(name) || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(name);
const PORTABLE = (path: string) => path.split('/').every(part => Boolean(part) && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f:]/.test(part) && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

const TOOL_FILES = new Set(['build-host-preflight.ps1','build-job.ps1','build.mjs','build-visual.mjs','construction-clean-install.mjs','demo.mjs','entity-builder.mjs','factory.mjs','frontend-closure.mjs','generation-preflight.mjs','link-workspaces.mjs','local-profile.mjs','product-source.mjs','studio-catalogue.mjs','workspace-identities.mjs']);
const TEMPLATE_FILES = new Set(['entity-backend.ts.txt','entity-ui.ts.txt','entity.css.txt','module-backend.ts.txt','module-ui.ts.txt']);
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
  const normalized = relativePath.replaceAll('\\','/');
  if (normalized === 'packages/mobile-shell/src/mobile.css' && !directory) return true;
  if (normalized === 'tools/mobile' && directory) return true;
  if (normalized === 'tools/mobile/assemble.mjs' && !directory) return true;
  if (normalized.startsWith('tools/mobile/')) throw new Error('Unreviewed mobile build tool input is not allowed: ' + relativePath);
  if (normalized === 'templates/mobile' && directory) return true;
  if (!directory && ['templates/mobile/package.json','templates/mobile/package-lock.json','templates/mobile/README.md'].includes(normalized)) return true;
  if (normalized.startsWith('templates/mobile/')) throw new Error('Unreviewed mobile template input is not allowed: ' + relativePath);
  if (['apps','packages','modules'].includes(top)) {
    if (parts.length === 2) return directory;
    if (parts.length === 3 && !directory && (leaf === 'package.json' || leaf === 'tsconfig.json' || (top === 'modules' && ['module.json','entity-spec.json','generation.json','README.md'].includes(leaf)))) return true;
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
  } else if (top === 'families') {
    if (parts.length === 2) return directory && /^[a-z][a-z0-9-]{1,47}$/.test(leaf);
    if (parts.length === 3 && !directory && leaf === 'family.json') return true;
  } else if (top === 'products' || top === 'solutions') {
    if (parts.length === 2) return directory && /^[a-z][a-z0-9-]{1,47}$/.test(leaf);
    if (parts.length === 3 && !directory && ((top === 'products' && leaf === 'product.json') || (top === 'solutions' && (leaf === 'solution.json' || leaf === 'wiring.mjs' || leaf === 'ui.json')))) return true;
  } else if (top === 'tools') {
    if (parts.length === 2 && (leaf === 'registry-publish.ps1' || leaf === 'runtime-recovery-publish.ps1' || leaf === 'runtime-recovery.mjs' || leaf === 'runtime-supervisor.mjs' ||
        leaf === 'runtime-upgrade.mjs' || leaf === 'runtime-upgrade-publish.ps1')) return false;
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
  const rootInfo = await lstat(root);
  if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())throw new Error(`Private toolchain root is not a regular directory: ${root}`);
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
  const packages=await selectPrivateToolchain(root), hash=createHash('sha256');
  const nodeHash=sha(await readFile(process.execPath));
  hash.update(process.version);hash.update('\0');hash.update(nodeHash);
  for(const item of packages){
    hash.update(item.name);hash.update('\0');hash.update(item.version);hash.update('\0');hash.update(await completeTreeDigest(join(root,item.packagePath)));
  }
  return hash.digest('hex');
}

export async function copyPrivateToolchain(root: string,destination: string): Promise<void> {
  const packages=await selectPrivateToolchain(root);
  for(const item of packages){
    const {packagePath}=item;
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

interface PrivateToolchainPackage { name: string; packagePath: string; version: string; }
const PINNED_ESBUILD = '0.28.2';

async function readRegularJson(path: string): Promise<any> {
  const info=await lstat(path);
  if(info.isSymbolicLink()||!info.isFile())throw new Error(`Pinned toolchain metadata is not a regular file: ${path}`);
  return JSON.parse(await readFile(path,'utf8'));
}

async function selectPrivateToolchain(root: string): Promise<PrivateToolchainPackage[]> {
  if(process.env.ESBUILD_BINARY_PATH)throw new Error('ESBUILD_BINARY_PATH overrides the selected private toolchain');
  const rootPackage=await readRegularJson(join(root,'package.json'));
  const lock=await readRegularJson(join(root,'package-lock.json'));
  const packages: PrivateToolchainPackage[]=[];
  const compilerNames=['typescript','@types/node','undici-types'];
  for(const name of compilerNames){
    const packagePath=name==='@types/node'?'node_modules/@types/node':`node_modules/${name}`;
    const installed=await readRegularJson(join(root,packagePath,'package.json'));
    const locked=lock.packages?.[packagePath]?.version;
    const spec=name==='undici-types'?lock.packages?.['node_modules/@types/node']?.dependencies?.['undici-types']:rootPackage.devDependencies?.[name];
    if(typeof installed.version!=='string'||installed.version!==locked||typeof spec!=='string'||spec.replace(/^[^0-9]*/,'')!==locked)
      throw new Error(`Installed compiler package ${name} does not match the pinned lockfile`);
    packages.push({name,packagePath,version:locked});
  }

  const esbuildPath='node_modules/esbuild', esbuildName='esbuild';
  const esbuild=await readRegularJson(join(root,esbuildPath,'package.json'));
  const lockedEsbuild=lock.packages?.[esbuildPath];
  if(rootPackage.devDependencies?.[esbuildName]!==PINNED_ESBUILD||lock.packages?.['']?.devDependencies?.[esbuildName]!==PINNED_ESBUILD||
      esbuild.name!==esbuildName||esbuild.version!==PINNED_ESBUILD||lockedEsbuild?.version!==PINNED_ESBUILD)
    throw new Error('Installed esbuild does not match the pinned root package specification and lockfile');

  const nativeName=`@esbuild/${process.platform}-${process.arch}`;
  const optionalVersion=esbuild.optionalDependencies?.[nativeName];
  const lockedOptional=lockedEsbuild?.optionalDependencies?.[nativeName];
  const nativePath=`node_modules/${nativeName}`;
  const lockedNative=lock.packages?.[nativePath];
  const native=await readRegularJson(join(root,nativePath,'package.json'));
  if(optionalVersion!==PINNED_ESBUILD||lockedOptional!==PINNED_ESBUILD||lockedNative?.version!==PINNED_ESBUILD||
      native.name!==nativeName||native.version!==PINNED_ESBUILD||!Array.isArray(native.os)||!native.os.includes(process.platform)||
      !Array.isArray(native.cpu)||!native.cpu.includes(process.arch))
    throw new Error(`Installed esbuild native package ${nativeName} does not match the pinned lockfile and current platform`);

  const executable=join(root,nativePath,process.platform==='win32'?'esbuild.exe':'bin/esbuild');
  const executableInfo=await lstat(executable);
  if(executableInfo.isSymbolicLink()||!executableInfo.isFile()||(process.platform!=='win32'&&(executableInfo.mode&0o111)===0))
    throw new Error(`Pinned esbuild native executable is missing or not a regular executable: ${nativeName}`);
  packages.push({name:esbuildName,packagePath:esbuildPath,version:PINNED_ESBUILD},{name:nativeName,packagePath:nativePath,version:PINNED_ESBUILD});
  return packages;
}
