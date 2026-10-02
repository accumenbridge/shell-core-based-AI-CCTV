import test from 'node:test';import assert from 'node:assert/strict';import {defineModule,capability} from '../packages/module-sdk/dist/index.js';
test('module SDK creates a full vertical-slice manifest',()=>{const m=defineModule({id:'sample-ai',version:'1.0.0',dependencies:[],provides:[capability('sample.answer.v1')],requires:[],permissions:['sample.read'],routes:[],workspaces:[],schema:{current:1,readMin:1,readMax:1},background:false,studio:{layers:['backend','ai','data'],ai:{pipelines:[{id:'sample-pipeline',label:'Sample',input:'text',output:'text'}]},data:{stores:[{id:'sample-store',kind:'vector',ownership:'module'}]}}});assert.equal(m.abi,'quadbridge.module.v1');assert.equal(m.studio.ai.pipelines.length,1);});
test('module SDK accepts a validated owned operation declaration and rejects unsupported schema keywords',()=>{
 const operation={id:'sample-ai.documents.search',version:1,title:'Search',description:'Search a bounded source set.',permission:'sample.read',kind:'read',inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:80}},required:['query'],additionalProperties:false},outputSchema:{type:'object',properties:{count:{type:'integer',minimum:0}},required:['count'],additionalProperties:false}};
 const base={id:'sample-ai',version:'1.0.0',dependencies:[],provides:[],requires:[],permissions:['sample.read'],routes:[],workspaces:[],schema:{current:1,readMin:1,readMax:1},background:false};
 assert.equal(defineModule({...base,operations:[operation]}).operations[0].id,operation.id);
 assert.throws(()=>defineModule({...base,operations:[{...operation,inputSchema:{...operation.inputSchema,patternProperties:{}}}]}),/Unsupported|operation/i);
 assert.throws(()=>defineModule({...base,operations:[{...operation,permission:'sample.write'}]}),/permission/i);
});
test('module SDK validates fixed read-only UI contributions against owned permissions',()=>{
 const base={id:'sample-module',version:'1.0.0',dependencies:[],provides:[],requires:[],permissions:['sample.read'],routes:[],workspaces:[],schema:{current:1,readMin:1,readMax:1},background:false};
 const descriptor={id:'sample-module.referenceSearch',permission:'sample.read',export:'referenceSearchPanel',label:'Reference search'};
 assert.deepEqual(defineModule({...base,uiContributions:[descriptor]}).uiContributions,[descriptor]);
 assert.throws(()=>defineModule({...base,uiContributions:[{...descriptor,permission:'sample.write'}]}),/Invalid UI contribution descriptor/);
 assert.throws(()=>defineModule({...base,uiContributions:[{...descriptor,export:'../runtime'}]}),/Invalid UI contribution descriptor/);
});
