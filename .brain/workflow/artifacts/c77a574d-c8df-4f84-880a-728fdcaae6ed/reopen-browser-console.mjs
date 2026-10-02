import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {startControlPlane} from '../../apps/control-plane/dist/main.js';
const dir='.local/family-001',read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const ready=read(`${dir}/browser-01-ready.json`),frozen=read(`${dir}/frozen.json`),prior=read(`${dir}/browser-console-original-close.json`);
if(prior.observedExitCode!==1||prior.fixtureId!==ready.fixtureId)throw Error('Original task-console termination must be observed before reopening retained fixture');
const inspect=()=>{for(const f of frozen.candidate.files)if(createHash('sha256').update(fs.readFileSync(f.path)).digest('hex')!==f.sha256)throw Error('Frozen source changed');};inspect();
const log=console.log,warn=console.warn;console.log=()=>{};console.warn=()=>{};let server;
try{server=await startControlPlane({root:ready.root,port:0});}finally{console.log=log;console.warn=warn;}
fs.writeFileSync(`${dir}/browser-console-reopened.json`,JSON.stringify({fixtureId:ready.fixtureId,root:ready.root,url:server.url,candidate:frozen.candidate.digest,purpose:'Reopen retained positively stopped test fixture to observe actual graceful controller close; does not retroactively qualify first fixture close.'},null,2)+'\n',{flag:'wx'});
console.log('REOPENED_CONTROLLER_READY');let closing=false;
process.stdin.resume();process.stdin.on('data',chunk=>{if(closing||!chunk.toString('utf8').split(/\r?\n/).includes(`STOP:${ready.fixtureId}`))return;closing=true;void(async()=>{await server.close();inspect();fs.writeFileSync(`${dir}/browser-console-graceful-close.json`,JSON.stringify({fixtureId:ready.fixtureId,candidate:frozen.candidate.digest,closed:true,sourceUnchanged:true,observedAt:new Date().toISOString(),scope:'Actual reopened controller graceful close on retained same fixture; first explicit termination remains exit1.'},null,2)+'\n',{flag:'wx'});process.stdin.pause();console.log('REOPENED_CONTROLLER_CLOSED');})().catch(error=>{console.error('REOPENED_CONTROLLER_CLOSE_UNVERIFIED',error.code??'UNKNOWN');closing=false;});});
