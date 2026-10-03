import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=resolve(process.argv[2]),evidence=resolve(process.argv[3]),phase=process.argv[4];
const api=await import(pathToFileURL(join(root,'tools/veyviz-inventory.mjs')).href);
const source=await api.captureAuthoredBuildInputs(root),toolchain=await api.captureBuildToolchain(root);
const freezeDir=join(root,'evidence','freeze-run-07');
const frozenSource=JSON.parse(await readFile(join(freezeDir,'source-overlay.json'),'utf8'));
const frozenTool=JSON.parse(await readFile(join(freezeDir,'toolchain-overlay.json'),'utf8'));
const prior=phase==='pre-build'?null:phase==='post-build'?'pre-build':'post-build';
if(prior){const es=JSON.parse(await readFile(join(evidence,`${prior}-source.json`),'utf8')),et=JSON.parse(await readFile(join(evidence,`${prior}-toolchain.json`),'utf8'));if(JSON.stringify(source)!==JSON.stringify(es)||JSON.stringify(toolchain)!==JSON.stringify(et))throw Error(`${phase} source/toolchain mismatch against ${prior}`)}
else if(JSON.stringify(source)!==JSON.stringify(frozenSource)||JSON.stringify(toolchain)!==JSON.stringify(frozenTool))throw Error('Pre-build overlay does not match freeze07');
const hash=b=>createHash('sha256').update(b).digest('hex');
const put=async(name,value)=>{const b=Buffer.from(JSON.stringify(value,null,2)+'\n');await writeFile(join(evidence,name),b,{flag:'wx'});return{path:join(evidence,name),bytes:b.length,sha256:hash(b)}};
const sourceFile=await put(`${phase}-source.json`,source),toolchainFile=await put(`${phase}-toolchain.json`,toolchain);
const meta={schema:'veyviz.isolated-run-source-capture.v1',phase,capturedAt:new Date().toISOString(),sourceDigest:source.digest,toolchainDigest:toolchain.digest,sourceFiles:source.files.length,sourceFile,toolchainFile};
await put(`${phase}-capture.json`,meta);
console.log(JSON.stringify(meta,null,2));
