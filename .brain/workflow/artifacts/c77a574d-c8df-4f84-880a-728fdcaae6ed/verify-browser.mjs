import fs from 'node:fs';
import {createHash} from 'node:crypto';
const dir='.local/family-001',read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const frozen=read(`${dir}/frozen.json`),owner=read(`${dir}/browser-01-owner-evidence.json`),browser=read(`${dir}/browser-observations-01.json`),consoleClose=read(`${dir}/browser-console-original-close.json`);
for(const f of frozen.candidate.files)if(createHash('sha256').update(fs.readFileSync(f.path)).digest('hex')!==f.sha256)throw Error('Frozen source changed');
if(owner.candidate!==frozen.candidate.digest||owner.contractDigest!==frozen.contractDigest||browser.candidate!==owner.candidate||browser.fixtureId!==owner.fixtureId||consoleClose.fixtureId!==owner.fixtureId)throw Error('Exact browser source/fixture binding differs');
const at=label=>browser.observations.find(item=>item.label===label)?.dom??'';
const assertions=[
 ['required business diagnostic',at('unmet-choice-diagnostic').includes('Document handoff requires Shared library.')],
 ['preview removed on feature change',!at('selection-invalidates-preview').includes('Save immutable family-web@1.0.0')],
 ['fresh save starts unchecked',at('current-preview').includes('checkbox "Save the exact immutable version family-web@1.0.0."\n')],
 ['exact immutable saved with original source provenance',at('immutable-family-saved').includes('Saved from service-operations@1.0.0 with the original source fingerprint.')],
 ['actual indexed search body',at('live-search-returned').includes('familybrowserneedle: isolate the service pump')],
 ['actual destination confirmed',at('handoff-destination-outcome').includes('Destination confirmed')],
 ['same document retained after restart',at('restart-retained-indexed-document').includes('9928fc22-a063-4f11-943f-d7545257098e')&&at('restart-retained-indexed-document').includes('READY · worker SUCCEEDED')],
 ['confirmed handoff retained',at('restart-retained-confirmed-handoff').includes('Destination confirmed')],
 ['destination source identity retained',at('restart-retained-destination-request').includes('9928fc22-a063-4f11-943f-d7545257098e')&&at('restart-retained-destination-request').includes('OPEN · revision 1')],
 ['positive final browser stop',at('final-stop-result').includes('STOPPED with an empty process tree and cleaned execution recorded.')],
 ['original native owners empty/closed/clean',owner.attempts.length===2&&owner.attempts.every(a=>a.state==='STOPPED'&&a.physicalState==='EMPTY'&&a.emptyObserved===1&&a.helperClosed===1&&a.executionClean===1)],
 ['immutable artifact binding',owner.builds[0].snapshotDigest===owner.instances[0].artifactDigest&&owner.instances[0].productId==='family-web'&&owner.instances[0].version==='1.0.0'],
 ['actual stored family claim',owner.familyDerivation.familyId==='service-operations'&&owner.familyDerivation.selection.length===3],
 ['original console termination observed separately',consoleClose.observedExitCode===1]
];
for(const [label,passed] of assertions)if(!passed)throw Error(`Actual browser evidence missing: ${label}`);
const result={kind:'manual-browser-evidence-verification',actualProcess:['node','.local/family-001/verify-browser.mjs'],candidate:frozen.candidate.digest,contractDigest:frozen.contractDigest,fixtureId:owner.fixtureId,assertions:assertions.map(([label,passed])=>({label,passed})),sourceUnchanged:true,limitations:['Actual Chrome actions are manual agent observations; this separate verification command checks the captured evidence and native original closure, it is not a replacement browser driver.','Root omitted tty for the fixture console: stdin shutdown unavailable; after actual native EMPTY/closed/clean and settled build/registry, exact live task listener was terminated and original console process exit1 observed. Graceful console close is unqualified; fixture retained.','Earlier file-import policy block, native phone/provider/hosted/production remain unqualified.']};
fs.writeFileSync(`${dir}/browser-verified-01.json`,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({verified:assertions.length,candidate:frozen.candidate.digest,nativeAttempts:owner.attempts.length,consoleExitSeparatelyObserved:consoleClose.observedExitCode}));
