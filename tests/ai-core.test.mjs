import test from 'node:test';import assert from 'node:assert/strict';import {planAiPipeline,chooseModel,BoundedProviderExecutor,lexicalTerms} from '../packages/ai-core/dist/index.js';
test('AI pipeline validates and compiles into deterministic stages',()=>{const plan=planAiPipeline({schema:'quadbridge.ai-pipeline.v1',id:'document-assistant',version:'1.0.0',label:'Document assistant',nodes:[{id:'input',kind:'input'},{id:'embed',kind:'embedding',capability:'text.embedding'},{id:'retrieve',kind:'retriever'},{id:'answer',kind:'model',capability:'text.generate'},{id:'output',kind:'output'}],edges:[{from:'input',to:'embed'},{from:'embed',to:'retrieve'},{from:'retrieve',to:'answer'},{from:'answer',to:'output'}],policy:{timeoutMs:30000,maxParallel:4,dataClass:'internal',placement:'hybrid'}});assert.equal(plan.stages.length,5);assert.deepEqual(plan.requiredCapabilities,['text.embedding','text.generate']);});
test('AI pipeline rejects cycles',()=>{assert.throws(()=>planAiPipeline({schema:'quadbridge.ai-pipeline.v1',id:'bad-pipeline',version:'1.0.0',label:'Bad',nodes:[{id:'input',kind:'input'},{id:'output',kind:'output'}],edges:[{from:'input',to:'output'},{from:'output',to:'input'}],policy:{timeoutMs:1000,maxParallel:1,dataClass:'internal',placement:'edge'}}),/cycle/);});
test('model routing respects capability and placement',()=>{assert.equal(chooseModel('vision.detect','edge',[{id:'cloud',capabilities:['vision.detect'],placement:'cloud',available:true,priority:1},{id:'edge',capabilities:['vision.detect'],placement:'edge',available:true,priority:2}]).id,'edge');});
test('AI runtime validation rejects unknown kinds, coercible fields, unsafe policy values, and non-JSON config',()=>{
 const valid={schema:'quadbridge.ai-pipeline.v1',id:'valid-pipeline',version:'1.0.0',label:'Valid',nodes:[{id:'input',kind:'input'},{id:'answer',kind:'model',capability:'text.generate'},{id:'output',kind:'output'}],edges:[{from:'input',to:'answer'},{from:'answer',to:'output'}],policy:{timeoutMs:1000,maxParallel:1,dataClass:'internal',placement:'edge'}};
 assert.throws(()=>planAiPipeline({...valid,id:['valid-pipeline']}),/identity/);
 assert.throws(()=>planAiPipeline({...valid,version:['1.0.0']}),/identity/);
 assert.throws(()=>planAiPipeline({...valid,policy:{...valid.policy,dataClass:['internal']}}),/policy/);
 assert.throws(()=>planAiPipeline({...valid,policy:{...valid.policy,placement:['edge']}}),/policy/);
 assert.throws(()=>planAiPipeline({...valid,nodes:[...valid.nodes.slice(0,1),{id:'answer',kind:'model-serving'},valid.nodes[2]]}),/kind/);
 assert.throws(()=>planAiPipeline({...valid,nodes:[...valid.nodes.slice(0,1),{id:'answer',kind:'model',config:{value:undefined}},valid.nodes[2]]}),/JSON/);
 assert.throws(()=>planAiPipeline({...valid,extra:true}),/fields/);
 assert.throws(()=>planAiPipeline({...valid,edges:[...valid.edges,valid.edges[0]]}),/Duplicate AI edge/);
});

test('lexical question terms discard common question words and remain bounded',()=>{
 assert.deepEqual(lexicalTerms('How should a conveyor be isolated?'),['conveyor','isolated']);
 assert.equal(lexicalTerms(Array.from({length:80},(_,i)=>`item${i}x`).join(' ')).length,32);
});

test('provider cancellation suppresses the caller but holds one of four slots until actual settlement',async()=>{
 const executor=new BoundedProviderExecutor(), gates=[], controllers=Array.from({length:5},()=>new AbortController());
 let started=0;
 const provider=({signal})=>{started++;return new Promise(resolve=>gates.push({resolve,signal}));};
 const running=controllers.slice(0,4).map(controller=>executor.run(provider,{signal:controller.signal}));
 const until=async(predicate,label)=>{const end=Date.now()+2000;while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail(`Timed out waiting for ${label}`);};
 await until(()=>started===4,'four actual provider calls');
 controllers[0].abort();
 await assert.rejects(running[0],/cancelled/);
 assert.equal(executor.inFlight,4);
 await assert.rejects(executor.run(provider,{signal:controllers[4].signal}),/concurrency limit/);
 for(const gate of gates)gate.resolve({evidenceIds:[]});
 await Promise.all(running.slice(1));
 await until(()=>executor.inFlight===0,'actual providers to settle');
 assert.equal(gates[0].signal.aborted,true);
});
