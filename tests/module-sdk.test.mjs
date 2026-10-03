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

test('module SDK defaults only an absent ABI and validates exact supported module versions',()=>{
 const base={id:'sample-module',version:'1.0.0',dependencies:[],provides:[],requires:[],permissions:[],routes:[],workspaces:[],schema:{current:1,readMin:1,readMax:1},background:false};
 assert.equal(defineModule(base).abi,'quadbridge.module.v1');
 assert.throws(()=>defineModule({...base,abi:'quadbridge.module.v0'}),/ABI/);
 for(const version of ['1.0','v1.0.0','01.0.0','1.0.0-beta','^1.0.0'])
  assert.throws(()=>defineModule({...base,version}),/exact supported SemVer/);
 assert.equal(defineModule({...base,id:'a'}).id,'a','contract validation retains one-character fixture IDs');
});

test('module SDK detaches and deeply freezes every nested declaration value',()=>{
 const operation={id:'sample-module.items.find',version:1,title:'Find item',description:'Find an owned item.',permission:'sample.read',kind:'read',inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:80}},required:['query'],additionalProperties:false},outputSchema:{type:'object',properties:{count:{type:'integer',minimum:0}},required:['count'],additionalProperties:false}};
 const original={id:'sample-module',version:'1.0.0',dependencies:[],provides:[],requires:[],permissions:['sample.read','sample.write'],routes:[{method:'GET',path:'/api/sample-module',permission:'sample.read',kind:'read'}],workspaces:[{id:'sample-module.main',label:'Sample',path:'/sample-module',permission:'sample.read',export:'workspace'}],schema:{current:1,readMin:1,readMax:1},background:false,operations:[operation],studio:{layers:['backend']}};
 const shallowFrozen=Object.freeze({...original});
 const manifest=defineModule(shallowFrozen);
 original.permissions[0]='sample.changed';original.routes[0].permission='sample.changed';operation.inputSchema.properties.query.maxLength=2;original.studio.layers[0]='invalid';
 assert.equal(manifest.permissions[0],'sample.read');
 assert.equal(manifest.routes[0].permission,'sample.read');
 assert.equal(manifest.operations[0].inputSchema.properties.query.maxLength,80);
 assert.equal(manifest.studio.layers[0],'backend');
 assert.ok(Object.isFrozen(manifest)&&Object.isFrozen(manifest.permissions)&&Object.isFrozen(manifest.routes[0]));
 assert.ok(Object.isFrozen(manifest.operations[0].inputSchema.properties.query));
 assert.ok(Object.isFrozen(manifest.studio.layers));
 assert.throws(()=>{manifest.studio.layers[0]='changed';},TypeError);
});

test('module SDK rejects accessors and unsupported non-data values without invoking getters',()=>{
 const base={id:'sample-module',version:'1.0.0',dependencies:[],provides:[],requires:[],permissions:[],routes:[],workspaces:[],schema:{current:1,readMin:1,readMax:1},background:false};
 let invoked=0;
 const accessor=Object.defineProperty({...base},'permissions',{enumerable:true,get(){invoked++;return[];}});
 assert.throws(()=>defineModule(accessor),/accessor/);
 assert.equal(invoked,0);
 const cyclic={...base};cyclic.studio={};cyclic.studio.parent=cyclic;
 assert.throws(()=>defineModule(cyclic),/cycles/);
 assert.throws(()=>defineModule({...base,studio:{value:undefined}}),/plain data/);
});

test('module SDK enforces declaration-local route and workspace permission ownership',()=>{
 const base={id:'sample-module',version:'1.0.0',dependencies:[],provides:[],requires:[],permissions:[],routes:[],workspaces:[],schema:{current:1,readMin:1,readMax:1},background:false};
 assert.throws(()=>defineModule({...base,routes:[{method:'GET',path:'/api/sample-module',permission:'sample.read',kind:'read'}]}),/Undeclared route permission/);
 assert.throws(()=>defineModule({...base,workspaces:[{id:'sample-module.main',label:'Sample',path:'/sample-module',permission:'sample.read',export:'workspace'}]}),/Undeclared workspace permission/);
 const route={method:'GET',path:'/api/sample-module',permission:'sample.read',kind:'read'};
 assert.throws(()=>defineModule({...base,permissions:['sample.read'],routes:[route,{...route}]}),/Duplicate route/);
});
