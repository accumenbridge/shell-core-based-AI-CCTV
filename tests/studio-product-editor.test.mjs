import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { TextEncoder } from 'node:util';
import { ROOT } from '../apps/runtime/dist/index.js';
import { composeDraft, inspectProductDefinition, parseProductDefinition, serializeProductDefinition } from '../packages/composition/dist/studio.js';
import { deriveFamily } from '../packages/composition/dist/family.js';
import { browserCore, readCatalogue } from '../tools/studio-catalogue.mjs';

const compiledStudioMain = new URL('../apps/studio-web/dist/main.js', import.meta.url);
const sourceCatalogue=await readCatalogue(ROOT);
const makeProduct=(version='2.4.0')=>composeDraft({id:'definition-editor',title:'Definition editor',version,selected:['handoff']},sourceCatalogue.modules,sourceCatalogue.solutions).product;

const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate,label){const deadline=Date.now()+3000;while(Date.now()<deadline){if(predicate())return;await pause();}assert.fail(`Timed out waiting for ${label}`);}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function response(body,status=200){return {ok:status>=200&&status<300,status,async json(){return body;}};}
function parseInContext(context,value){context.__jsonFixture=JSON.stringify(value);try{return vm.runInContext('JSON.parse(globalThis.__jsonFixture)',context);}finally{delete context.__jsonFixture;}}

class ProductEditorFakeApp{
  html='';
  inputs=[];
  set innerHTML(value){this.html=value;this.inputs=[...value.matchAll(/<input\b([^>]*)>/g)].map(match=>{
    const attributes=Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(found=>[found[1],found[2]??true]));
    const dataset={};for(const [name,attribute] of Object.entries(attributes))if(name.startsWith('data-'))dataset[name.slice(5).replace(/-([a-z])/g,(_whole,letter)=>letter.toUpperCase())]=attribute;
    return {dataset,checked:Object.hasOwn(attributes,'checked'),disabled:Object.hasOwn(attributes,'disabled')};
  });}
  get innerHTML(){return this.html;}
  querySelectorAll(selector){return selector==='[data-runtime-confirmation]'?this.inputs.filter(input=>input.dataset.runtimeConfirmation!==undefined):[];}
  querySelector(selector){return selector==='[data-product-json]'?new ProductEditorFakeTextArea(''):null;}
  saveConfirmation(){return this.inputs.find(input=>input.dataset.productSaveConfirm!==undefined);}
}
class ProductEditorFakeTextArea{
  constructor(value){this.value=value;this.dataset={productJson:''};this.selectionStart=0;this.selectionEnd=0;}
  closest(){return null;}
  matches(selector){return selector==='[data-product-json]';}
  focus(){}
  setSelectionRange(){}
}

async function productEditorUiHarness({initialHash='#overview',catalogueReads=[],product=makeProduct('3.1.0'),catalogueValue,
  familyDeriveReplies=[]}={}){
  const source=(await readFile(compiledStudioMain,'utf8')).replace(/^export \{\};?\s*$/m,'').replace(/^\/\/# sourceMappingURL=.*$/m,'');
  const app=new ProductEditorFakeApp(),documentListeners=new Map(),windowListeners=new Map(),calls=[],catalogueQueue=[...catalogueReads],saveReplies=[];
  const overview={platform:{version:'0.3',mode:'local'},modules:[],products:[],productVersions:[],coverage:[],builds:[],environments:[],deployments:[],aiPipelines:[],audit:[],capabilities:[]};
  const catalogue=catalogueValue??{modules:[{id:'service-desk',version:'0.2.0',studio:{layers:['backend']}}],solutions:[],families:[]};
  const fetch=async(path,options={})=>{
    const call={path,options,body:options.body?JSON.parse(options.body):undefined};calls.push(call);
    if(path==='/platform-api/session')return response({});
    if(path==='/platform-api/overview')return response(overview);
    if(path==='/platform-api/catalogue'){
      const next=catalogueQueue.shift();return next?await next.promise:response(catalogue);
    }
    if(path==='/platform-api/products/derive-family'){
      const next=familyDeriveReplies.shift();return next?.promise?await next.promise:next??response({});
    }
    if(path==='/platform-api/products/compose')return response({product});
    if(path==='/platform-api/products/preview')return response({valid:true,product:call.body.product,diagnostics:[],graph:{nodes:[],edges:[]},status:'The definition is valid.'});
    if(path==='/platform-api/products'&&options.method==='POST'){
      const next=saveReplies.shift();return next?await next.promise:response({saved:true});
    }
    if(path==='/platform-api/logout'&&options.method==='POST')return response({ok:true});
    throw new Error(`Unexpected UI request ${options.method??'GET'} ${path}`);
  };
  let hash=initialHash;
  const location={get hash(){return hash;},set hash(value){const normalized=value.startsWith('#')?value:`#${value}`;if(normalized===hash)return;hash=normalized;queueMicrotask(()=>windowListeners.get('hashchange')?.());}};
  let confirmCalls=0;
  const context=vm.createContext({
    TextEncoder,HTMLTextAreaElement:ProductEditorFakeTextArea,FormData:class{constructor(form){this.form=form;}get(name){return this.form.values?.[name]??null;}},
    document:{getElementById:id=>id==='app'?app:null,addEventListener:(name,listener)=>documentListeners.set(name,listener)},
    window:{addEventListener:(name,listener)=>windowListeners.set(name,listener),confirm(){confirmCalls++;return true;}},
    location,fetch,crypto:{randomUUID:()=>`editor-test-${calls.length}`},setInterval:()=>1,clearInterval:()=>{},console,
  });
  new vm.Script(source).runInContext(context);
  const byRoute=route=>({dataset:{route},closest(selector){return selector==='[data-route]'?this:null;}});
  const bySelector=selector=>({closest(candidate){return candidate===selector?this:null;}});
  const click=target=>documentListeners.get('click')({target});
  const route=routeName=>click(byRoute(routeName));
  const setHash=value=>{location.hash=value.startsWith('#')?value:`#${value}`;};
  const compose=()=>{
    const values={id:'new-product',title:'New product',version:product.version,layout:'sidebar'};
    const form={matches:selector=>selector==='#compose-form',elements:{namedItem:name=>({value:values[name]})},querySelectorAll:()=>[]};
    documentListeners.get('submit')({target:form,preventDefault(){}});
  };
  const preview=()=>click(bySelector('[data-product-preview]'));
  const save=()=>{
    const article={querySelector:selector=>selector==='[data-product-save-confirm]'?app.saveConfirmation():null};
    const button={closest(selector){if(selector==='[data-product-save]')return this;if(selector==='.result-card')return article;return null;}};
    click({closest:selector=>selector==='[data-product-save]'?button:null});
  };
  const edit=sourceText=>documentListeners.get('input')({target:new ProductEditorFakeTextArea(sourceText)});
  const submitFamily=(values,selection)=>{
    const form={values,matches:selector=>selector==='#family-derive-form',querySelectorAll:selector=>selector==='input[name="familyFeature"]:checked'?selection.map(value=>({value})):[]};
    documentListeners.get('submit')({target:form,preventDefault(){}});
  };
  return {app,calls,location,confirmCalls:()=>confirmCalls,route,setHash,compose,preview,save,edit,
    submitFamily,until:(predicate,label)=>until(predicate,label),pause};
}

test('complete definition round-trip preserves description, exact versions, custom binding identity and wiring',()=>{
  const original=makeProduct();
  original.description='A retained product-owned summary.';
  original.modules=[...original.modules].reverse();
  original.bindings=original.bindings.map((binding,index)=>({...binding,instanceId:index===0?'customer-owned-desk':'custom-knowledge-link'}));
  const serialized=serializeProductDefinition(original,sourceCatalogue.modules,sourceCatalogue.solutions);
  const inspected=parseProductDefinition(serialized,sourceCatalogue.modules,sourceCatalogue.solutions);
  assert.equal(inspected.valid,true,JSON.stringify(inspected.diagnostics));
  assert.equal(inspected.product.description,original.description);
  assert.equal(inspected.product.version,original.version);
  assert.equal(inspected.product.wiring,original.wiring);
  assert.deepEqual(inspected.product.modules,[...original.modules].sort((a,b)=>a.id.localeCompare(b.id)));
  assert.deepEqual(inspected.product.bindings.map(binding=>binding.instanceId),original.bindings.map(binding=>binding.instanceId));
  assert.ok(inspected.graph.nodes.some(node=>node.id==='service-desk'&&node.version===sourceCatalogue.modules.find(m=>m.id==='service-desk').version));
  assert.ok(inspected.graph.edges.some(edge=>edge.instanceId==='customer-owned-desk'));
});

test('unsupported definition stays unchanged and returns diagnostics without a preview plan',()=>{
  const invalid=makeProduct();
  invalid.bindings[0]={...invalid.bindings[0],mode:'shell-command'};
  const source=`${JSON.stringify(invalid,null,2)}\n`;
  const before=structuredClone(invalid);
  const result=parseProductDefinition(source,sourceCatalogue.modules,sourceCatalogue.solutions);
  assert.equal(result.valid,false);
  assert.equal(result.plan,undefined);
  assert.ok(result.diagnostics.length>0);
  assert.deepEqual(invalid,before);
  assert.equal(source,`${JSON.stringify(before,null,2)}\n`);
});

test('editor helpers are present in the offline browser bundle and remain pure data operations',async()=>{
  const context=vm.createContext({TextEncoder});
  new vm.Script(await browserCore(ROOT)).runInContext(context);
  const product=makeProduct('2.4.1');
  product.description='Offline file round trip';
  product.bindings[0].instanceId='offline-instance-name';
  const fixture=parseInContext(context,{product,modules:sourceCatalogue.modules,solutions:sourceCatalogue.solutions});
  const text=context.QBComposer.serializeProductDefinition(fixture.product,fixture.modules,fixture.solutions);
  const result=context.QBComposer.parseProductDefinition(text,fixture.modules,fixture.solutions);
  const expected=parseProductDefinition(serializeProductDefinition(product,sourceCatalogue.modules,sourceCatalogue.solutions),sourceCatalogue.modules,sourceCatalogue.solutions);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),JSON.parse(JSON.stringify(expected)));
  assert.equal(result.valid,true,JSON.stringify(result.diagnostics));
  assert.equal(result.product.description,'Offline file round trip');
  assert.ok(result.product.bindings.some(binding=>binding.instanceId==='offline-instance-name'));
  assert.equal(typeof context.fetch,'undefined','the shared editor helpers do not acquire network authority');
});

test('inspection keeps supported HTTP bindings valid without claiming local launchability',()=>{
  const product=makeProduct();
  product.bindings=product.bindings.map(binding=>binding.contract==='desk.requests.create.v2'?{...binding,mode:'http',implementation:'configured-desk-http',scope:'application',instanceId:'mapped-destination'}:binding);
  const inspected=inspectProductDefinition(product,sourceCatalogue.modules,sourceCatalogue.solutions);
  assert.equal(inspected.valid,true,JSON.stringify(inspected.diagnostics));
  assert.ok(inspected.graph.nodes.some(node=>node.external&&node.id==='configured-desk-http'));
  assert.ok(inspected.graph.edges.some(edge=>edge.mode==='http'&&edge.instanceId==='mapped-destination'));
  assert.equal(inspected.status,undefined,'an inspected HTTP binding is only a definition; no local runtime claim is added');
});

test('Products click and genuine hash navigation both render the catalogue while stale navigation stays selected',async()=>{
  const firstCatalogue=deferred();
  const clicked=await productEditorUiHarness({catalogueReads:[firstCatalogue]});
  await clicked.until(()=>clicked.app.innerHTML.includes('Construction path'),'initial paired overview');
  clicked.route('products');
  await clicked.until(()=>clicked.calls.filter(call=>call.path==='/platform-api/catalogue').length===1,'first-click catalogue request');
  await clicked.pause();
  assert.equal(clicked.calls.filter(call=>call.path==='/platform-api/catalogue').length,1,'the redundant click hashchange does not start another load');
  firstCatalogue.resolve(response({modules:[{id:'service-desk',version:'0.2.0',studio:{layers:['backend']}}],solutions:[]}));
  await clicked.until(()=>clicked.app.innerHTML.includes('value="service-desk"'),'first Products module choices');
  assert.match(clicked.app.innerHTML,/<h1>Products<\/h1>/);

  const backCatalogue=deferred();
  const back=await productEditorUiHarness({catalogueReads:[backCatalogue]});
  await back.until(()=>back.app.innerHTML.includes('Construction path'),'second paired overview');
  back.setHash('products');
  await back.until(()=>back.calls.some(call=>call.path==='/platform-api/catalogue'),'genuine hash navigation catalogue request');
  backCatalogue.resolve(response({modules:[{id:'service-desk',version:'0.2.0',studio:{layers:['backend']}}],solutions:[]}));
  await back.until(()=>back.app.innerHTML.includes('value="service-desk"'),'genuine hash Products module choices');

  const staleCatalogue=deferred();
  const away=await productEditorUiHarness({catalogueReads:[staleCatalogue]});
  await away.until(()=>away.app.innerHTML.includes('Construction path'),'third paired overview');
  away.route('products');
  await away.until(()=>away.calls.some(call=>call.path==='/platform-api/catalogue'),'pending Products catalogue');
  away.route('modules');
  await away.until(()=>away.app.innerHTML.includes('<h1>Modules</h1>'),'navigation away while catalogue is pending');
  staleCatalogue.resolve(response({modules:[{id:'service-desk',version:'0.2.0',studio:{layers:['backend']}}],solutions:[]}));
  await away.pause();await away.pause();
  assert.match(away.app.innerHTML,/<h1>Modules<\/h1>/,'the old Products completion cannot repaint a newer route');
  assert.doesNotMatch(away.app.innerHTML,/Product definition editor/);
});

test('product save uses an unchecked exact-version confirmation and sends only the current preview',async()=>{
  const product=makeProduct('3.2.1');product.description='The complete previewed custom definition.';
  const ui=await productEditorUiHarness({initialHash:'#products',product});
  await ui.until(()=>ui.app.innerHTML.includes('Product definition editor'),'Products editor');
  ui.compose();
  await ui.until(()=>ui.app.innerHTML.includes('&quot;description&quot;: &quot;The complete previewed custom definition.&quot;'),'starter in the complete JSON editor');
  ui.preview();
  await ui.until(()=>ui.app.innerHTML.includes('Read-only composition preview'),'valid exact preview');
  assert.match(ui.app.innerHTML,/Save the exact immutable version definition-editor@3\.2\.1/);
  assert.equal(ui.app.saveConfirmation()?.checked,false,'save approval starts unchecked');
  assert.equal(ui.confirmCalls(),0,'no native confirmation is used');

  ui.save();
  await ui.until(()=>ui.app.innerHTML.includes('Confirm saving the exact immutable version'),'unchecked save explanation');
  assert.equal(ui.calls.filter(call=>call.path==='/platform-api/products'&&call.options.method==='POST').length,0,'unchecked save sends no mutation');

  ui.app.saveConfirmation().checked=true;
  ui.route('modules');
  await ui.until(()=>ui.app.innerHTML.includes('<h1>Modules</h1>'),'leave Products before saving');
  ui.route('products');
  await ui.until(()=>ui.app.innerHTML.includes('Product definition editor'),'return to Products');
  assert.equal(ui.app.saveConfirmation(),undefined,'navigation invalidates the preview and its save approval');

  ui.preview();
  await ui.until(()=>ui.app.innerHTML.includes('Read-only composition preview'),'fresh preview after navigation');
  ui.app.saveConfirmation().checked=true;
  ui.edit(`${JSON.stringify({...product,description:'Edited after preview'},null,2)}\n`);
  assert.equal(ui.app.saveConfirmation(),undefined,'editing invalidates the previous preview and its approval');
  ui.preview();
  await ui.until(()=>ui.app.innerHTML.includes('Read-only composition preview'),'preview of the edited definition');
  assert.equal(ui.app.saveConfirmation()?.checked,false,'a new preview requires fresh approval');
  ui.app.saveConfirmation().checked=true;
  ui.save();
  await ui.until(()=>ui.calls.some(call=>call.path==='/platform-api/products'&&call.options.method==='POST'),'confirmed immutable save request');
  const saveCall=ui.calls.find(call=>call.path==='/platform-api/products'&&call.options.method==='POST');
  assert.deepEqual(saveCall.body,{confirm:true,product:{...product,description:'Edited after preview'}});
  assert.equal(ui.confirmCalls(),0);
  assert.equal(ui.app.saveConfirmation(),undefined,'confirmation is consumed before the save result returns');
  await ui.until(()=>ui.app.innerHTML.includes('Saved definition-editor@3.2.1.'),'saved version result');
});

test('paired family defaults derive through the source catalogue and only an unchanged preview carries its family claim',async()=>{
  const family=sourceCatalogue.families.find(item=>item.id==='service-operations');
  assert.ok(family);
  const catalogueValue={modules:sourceCatalogue.modules,solutions:sourceCatalogue.solutions,families:[family]};
  const identity={id:'family-editor-proof',title:'Service Operations draft',version:'3.3.0',description:'',layout:'sidebar'};
  const selection=['requests','shared-library'];
  const composed=deriveFamily(family,selection,identity,catalogueValue.modules,catalogueValue.solutions);
  const familyDerivation={...composed.derivation,productDigest:'d'.repeat(64),sourceFingerprint:'f'.repeat(64)};
  const ui=await productEditorUiHarness({initialHash:'#products',catalogueValue,
    familyDeriveReplies:[response({...composed,familyDerivation})]});
  await ui.until(()=>ui.app.innerHTML.includes('Product definition editor')&&ui.app.innerHTML.includes('Reviewed product family'),'source family editor');
  assert.match(ui.app.innerHTML,/<h2>Service Operations<\/h2>/,'the paired family heading comes from source data');
  assert.match(ui.app.innerHTML,/name="familyFeature" value="requests" checked disabled/,'required feature default comes from the loaded family');
  assert.match(ui.app.innerHTML,/name="familyFeature" value="shared-library"(?! checked)/,'unselected feature is not silently added');
  ui.submitFamily({...identity,familyId:family.id},selection);
  await ui.until(()=>ui.calls.some(call=>call.path==='/platform-api/products/derive-family'),'paired family derivation request');
  await ui.until(()=>ui.app.innerHTML.includes('Family derivation'),'server-derived family explanation');
  const deriveCall=ui.calls.find(call=>call.path==='/platform-api/products/derive-family');
  assert.deepEqual(deriveCall.body,{familyId:family.id,selection,identity});
  assert.match(ui.app.innerHTML,/&quot;id&quot;: &quot;family-editor-proof&quot;/);
  assert.match(ui.app.innerHTML,/&quot;version&quot;: &quot;3\.3\.0&quot;/);
  ui.preview();
  await ui.until(()=>ui.app.innerHTML.includes('Read-only composition preview'),'exact derived ProductDefinition preview');
  assert.equal(ui.app.saveConfirmation()?.checked,false,'family derivation does not bypass exact-version confirmation');
  ui.app.saveConfirmation().checked=true;
  ui.save();
  await ui.until(()=>ui.calls.some(call=>call.path==='/platform-api/products'&&call.options.method==='POST'),'confirmed family save');
  const saveCall=ui.calls.find(call=>call.path==='/platform-api/products'&&call.options.method==='POST');
  assert.deepEqual(saveCall.body,{confirm:true,product:composed.product,derivation:{familyId:family.id,selection,identity}});
  assert.equal(ui.confirmCalls(),0,'the family flow does not use a native dialog');
  assert.equal(ui.app.saveConfirmation(),undefined,'the exact approval is consumed before the result');
  await ui.until(()=>ui.app.innerHTML.includes('Saved family-editor-proof@3.3.0.'),'family save completion');
});
