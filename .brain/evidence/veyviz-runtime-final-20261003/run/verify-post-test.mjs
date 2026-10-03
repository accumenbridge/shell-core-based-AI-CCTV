import {createHash} from 'node:crypto';import{readFile,writeFile}from'node:fs/promises';import{join,resolve}from'node:path';import{pathToFileURL}from'node:url';
const root=resolve(process.argv[2]),evidence=resolve(process.argv[3]),api=await import(pathToFileURL(join(root,'tools/veyviz-inventory.mjs')).href);
const verification=await api.verifyBuildQualification(root),postBuild=JSON.parse(await readFile(join(evidence,'post-build-qualification.json'),'utf8'));
if(JSON.stringify(verification)!==JSON.stringify(postBuild.verification))throw Error('Post-focus qualification/output identity differs from post-build verification');
const receipt=JSON.parse(await readFile(join(root,'.local','veyviz-build-qualification','current.json'),'utf8'));
const result={schema:'veyviz.post-focus-build-qualification.v1',checkedAt:new Date().toISOString(),verification,receiptStableDigest:receipt.stableDigest,outputDigest:receipt.stable.outputs.digest,buildOutcome:receipt.stable.buildOutcome,attempt:{id:receipt.attempt.id,finishedAt:receipt.attempt.finishedAt,original:receipt.attempt.original},equalToPostBuild:true};
await writeFile(join(evidence,'post-test-qualification.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result,null,2));
