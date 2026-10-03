type Capability = { id: string; status: string; detail: string };
type Overview = {
  platform: { version: string; mode: string };
  modules: { id: string; version: string; workspaces: number; routes: number; provides: number; requires: number; layers: string[]; aiPipelines: number; dataStores: number; schema: number }[];
  products: { id: string; title: string; version: string; modules: number }[];
  productVersions: { id:string; title:string; version:string; modules:number; valid?:boolean }[];
  coverage: { layer: string; modules: string[]; implemented: boolean; detail: string }[];
  builds: { id: string; productId: string; version: string; state: string; artifactDigest: string | null; inputDigest?: string | null; snapshotId?: string | null; snapshotDigest?: string | null; phase?: string; attempt?: number; failureCode?: string | null; failureMessage?: string | null; cleanupState?: string }[];
  environments: { id: string; label: string; kind: string; target: string; region: string | null }[];
  deployments: { id: string; environmentId: string; productId: string; version: string; buildId: string | null; state: string }[];
  aiPipelines: { id: string; version: string; digest: string; stages: number; capabilities: string }[];
  audit: { id: number; action: string; subject: string; payload: string; at: number; actorId: string | null }[];
  capabilities: Capability[];
};
type RuntimeGeneration={id:string;instanceId:string;generation:number;productId:string;version:string;artifactDigest:string;profileDigest:string;configDigest:string;
  adapterDigest:string;toolchainDigest:string;recipeDigest:string;originatingActorId:string;sourceGenerationId?:string|null;upgradeOperationId?:string|null;created:number};
type RuntimeUpgradeOperation={id:string;instanceId:string;sourceGenerationId:string;targetGenerationId?:string|null;sourceAttemptId:string;sourceAttempt:number;sourceCommandId:string;
  targetVersion:string;targetArtifactDigest:string;sourceBackupDigest:string;state:string;physicalState:string;driverEmpty:boolean;driverClosed:boolean;stagingClean:boolean;
  publisherResultObserved:boolean;publisherClosed:boolean;destinationPublished:boolean;destinationVerified:boolean;errorCode?:string|null;created:number;updated:number};
type RuntimeUpgradeList={instanceId:string;generations:RuntimeGeneration[];operations:RuntimeUpgradeOperation[]};
type ManagedRuntimeInstance={id:string;productId:string;version:string;artifactDigest:string;state:string;currentAttempt:number;activeGenerationId?:string;workerRequired:boolean;
  processObservation:string;url?:string;operationalError?:string;controlWarning?:string;events?:string;credentialFile?:string;nativeApiProfile?:string;modelAnswerProfile?:string;
  attempts?:{id:string;attempt:number;emptyObserved?:boolean;helperClosed?:boolean;executionClean?:boolean}[]};
type RuntimeRelease={productId:string;version:string;artifactDigest:string;originatingActorId?:string};
type RuntimeUpgradeIntent={instanceId:string;sourceAttempt:number;sourceArtifactDigest:string;sourceGenerationId:string;backupDigest:string;
  targetVersion:string;targetArtifactDigest:string;requestIdentity:string;instanceLockKey:string};
type RuntimeOverview={capability:{status:string;profile:string;details:string};slot:{state:string;instanceId:string|null;reservedBytes:number};instances:ManagedRuntimeInstance[]};
type RuntimeBackup={digest:string;instanceId:string;generationId?:string;attemptId?:string;attempt:number;productId:string;version:string;artifactDigest:string;capturedAt:number;sizeBytes:number;fileCount:number;creatingActorId?:string};
type RuntimeRecoveryOperation={id:string;kind:string;state:string;physicalState:string;created:number;errorCode?:string;backupDigest?:string;destinationVerified?:boolean;stagingClean?:boolean};
type RuntimeRecoveryList={capability:{status:string;detail:string};instanceId:string;backups:RuntimeBackup[];operations:RuntimeRecoveryOperation[]};
type RuntimeBackupVerification={digest:string;instanceId:string;sizeBytes:number;fileCount:number;capturedAt:number;verified:boolean};

const app = document.getElementById('app')!;
let data: Overview | null = null;
let route = 'overview';
let connected = false;
let loginError = '';
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const show = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? '—');
const nav = ['overview', 'products', 'modules', 'ui', 'backend', 'ai', 'data', 'builds', 'artifacts', 'runtime-instances', 'environments', 'deployments', 'audit', 'operations'];
const title = (value: string) => value.replace(/(^|-)(\w)/g, (_, separator, letter) => `${separator ? ' ' : ''}${letter.toUpperCase()}`);
let catalogue: { modules: { id:string; version:string; studio?:{layers?:string[]} }[]; solutions: unknown[]; families?:any[] } | null = null;
let composed: Record<string,any> | null = null;
const composeDraft:{id:string;title:string;version:string;layout:string;selected:string[]}={id:'',title:'',version:'1.0.0',layout:'sidebar',selected:[]};
const familyIdentity:{id:string;title:string;version:string;description:string;layout:'sidebar'|'top'}={id:'new-product',title:'New product',version:'1.0.0',description:'',layout:'sidebar'};
let selectedFamilyId='';
let selectedFamilyFeatures:string[]=[];
let familyDeriveBusy=false;
let familyClaimIntent:any=null;
let familyClaimGeneration=-1;
let familyDerivation:any=null;
let savedFamilyDerivation:any=null;
let productEditorText='';
let productPreview:any=null;
let productPreviewGeneration=-1;
let productEditorDiagnostics:string[]=[];
let productEditorGeneration=0;
let productEditorRequestSequence=0;
let productEditorBusy=false;
const productEditorArrayDrafts:Partial<Record<'modules'|'bindings',string>>={};
let productCatalogueSignature='';
let selectedSavedProduct='';
let actionError = '';
let buildDetails = new Map<string,string>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let sessionGeneration=0;
let disconnecting=false;
const overviewRefreshes=new Map<number,Promise<void>>();
let artifactRegistry:any=null;
let selectedArtifact:any=null;
let artifactLoadError='';
let artifactRegistryState:'idle'|'loading'|'ready'|'error'='idle';
let artifactRegistryRequest:{session:number;navigation:number;token:object;promise:Promise<void>}|undefined;
let artifactInspectionGeneration=0;
let artifactInspectionLoading=false;
let artifactInspectionDigest='';
let runtimeOverview:RuntimeOverview|null=null;
let runtimeReleases:RuntimeRelease[]=[];
let runtimeLoadError='';
let selectedRuntime:ManagedRuntimeInstance|null=null;
const runtimePending=new Set<string>();
const runtimeRequestKeys=new Map<string,string>();
const runtimeRecoveryLists=new Map<string,RuntimeRecoveryList>();
const runtimeRecoveryErrors=new Map<string,string>();
const runtimeBackupVerifications=new Map<string,RuntimeBackupVerification>();
const runtimeUpgradeLists=new Map<string,{identity:string;value:RuntimeUpgradeList}>();
const runtimeUpgradeErrors=new Map<string,string>();
const runtimeUpgradeRequests=new Set<string>();
const runtimeUpgradeTargets=new Map<string,string>();
const runtimeAndroidClients=new Map<string,{clientReference:string;outputDir:string;generationId:string;artifactDigest:string;productVersion:string}>();
let navigationGeneration=0,runtimeOverviewSequence=0,runtimeDetailSequence=0;

function invalidateProductEditor(){productEditorGeneration++;productEditorRequestSequence++;productPreview=null;productPreviewGeneration=-1;productEditorDiagnostics=[];productEditorBusy=false;familyClaimIntent=null;familyClaimGeneration=-1;familyDerivation=null;savedFamilyDerivation=null;delete productEditorArrayDrafts.modules;delete productEditorArrayDrafts.bindings;}
function clearProductEditor(){invalidateProductEditor();productEditorText='';selectedSavedProduct='';}
function parseProductEditorText(){
  if(new TextEncoder().encode(productEditorText).byteLength>65536)throw new Error('Product JSON exceeds the 64 KiB editor limit.');
  const value=JSON.parse(productEditorText);
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new Error('Product definition must be a JSON object.');
  return value as Record<string,any>;
}
function renderProductEditorKeeping(target:HTMLTextAreaElement|HTMLInputElement|HTMLSelectElement){
  const start=target instanceof HTMLTextAreaElement||target instanceof HTMLInputElement?target.selectionStart:null;
  const end=target instanceof HTMLTextAreaElement||target instanceof HTMLInputElement?target.selectionEnd:null;
  const key=target.dataset.productJson!==undefined?'json':target.dataset.productArray??target.dataset.productField??'';
  render();
  const replacement=key==='json'?app.querySelector<HTMLTextAreaElement>('[data-product-json]'):
    key==='modules'||key==='bindings'?app.querySelector<HTMLTextAreaElement>(`[data-product-array="${key}"]`):app.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-product-field="${key}"]`);
  if(replacement){replacement.focus();if(start!==null&&end!==null&&(replacement instanceof HTMLTextAreaElement||replacement instanceof HTMLInputElement))replacement.setSelectionRange(start,end);}
}
function setProductEditorText(source:string,target?:HTMLTextAreaElement|HTMLInputElement|HTMLSelectElement){
  productEditorText=source;selectedSavedProduct='';invalidateProductEditor();
  try{parseProductEditorText();productEditorDiagnostics=[];}catch(error){productEditorDiagnostics=[error instanceof Error?error.message:'Product definition is invalid.'];}
  if(target)renderProductEditorKeeping(target);else render();
}
function patchProductEditorField(field:string,value:unknown,target:HTMLInputElement|HTMLSelectElement){
  try{const product=parseProductEditorText();setProductEditorText(`${JSON.stringify({...product,[field]:value},null,2)}\n`,target);}
  catch(error){productEditorDiagnostics=[error instanceof Error?error.message:'Edit the complete JSON before using field controls.'];renderProductEditorKeeping(target);}
}
function patchProductEditorArray(field:'modules'|'bindings',source:string,target:HTMLTextAreaElement){
  invalidateProductEditor();
  try{const parsed=JSON.parse(source);if(!Array.isArray(parsed))throw new Error(`${field} must be a JSON array.`);const product=parseProductEditorText();productEditorText=`${JSON.stringify({...product,[field]:parsed},null,2)}\n`;productEditorDiagnostics=[];renderProductEditorKeeping(target);}
  catch(error){productEditorArrayDrafts[field]=source;productEditorDiagnostics=[error instanceof Error?error.message:`Invalid ${field} array.`];renderProductEditorKeeping(target);}
}

function clearRuntimeRecoveryState(){runtimeRecoveryLists.clear();runtimeRecoveryErrors.clear();runtimeBackupVerifications.clear();runtimeUpgradeLists.clear();runtimeUpgradeErrors.clear();runtimeUpgradeRequests.clear();runtimeUpgradeTargets.clear();runtimeAndroidClients.clear();}
function runtimeHasStoppedProof(instance:ManagedRuntimeInstance):boolean{
  if(instance.state!=='STOPPED'||instance.processObservation!=='positively-stopped')return false;
  let attempts=instance.attempts;
  if(attempts===undefined){
    const detail=selectedRuntime;
    if(!runtimeDetailMatches(detail,instance)||detail?.state!=='STOPPED'||detail.processObservation!=='positively-stopped')return false;
    attempts=detail.attempts;
  }
  const attempt=attempts?.find(item=>item.attempt===instance.currentAttempt);
  return attempt?.emptyObserved===true&&attempt.helperClosed===true&&attempt.executionClean===true;
}

function runtimeRequestKey(intent:string):string{
  let key=runtimeRequestKeys.get(intent);
  if(!key){key=`runtime:${crypto.randomUUID()}`;runtimeRequestKeys.set(intent,key);}
  return key;
}
function createRuntimeUpgradeIntent(instance:ManagedRuntimeInstance,generation:RuntimeGeneration,backup:RuntimeBackup,release:RuntimeRelease):RuntimeUpgradeIntent{
  const identity=JSON.stringify([instance.id,instance.currentAttempt,instance.artifactDigest,generation.id,backup.digest,release.version,release.artifactDigest]);
  return {instanceId:instance.id,sourceAttempt:instance.currentAttempt,sourceArtifactDigest:instance.artifactDigest,sourceGenerationId:generation.id,
    backupDigest:backup.digest,targetVersion:release.version,targetArtifactDigest:release.artifactDigest,requestIdentity:`UPGRADE:${identity}`,
    instanceLockKey:`UPGRADE_INSTANCE:${instance.id}`};
}
function runtimeResultMessage(action:'start'|'stop'|'restart',result:any):string{
  const commandState=typeof result?.command?.state==='string'?result.command.state:'unknown';
  const instance=result?.instance;
  const state=typeof instance?.state==='string'?instance.state:'unknown';
  const attempt=Array.isArray(instance?.attempts)?instance.attempts.find((item:any)=>item?.attempt===instance.currentAttempt&&
    typeof result?.operationId==='string'&&item.id===result.operationId):undefined;
  if(action==='start'&&state==='RUNNING'&&commandState==='SUCCEEDED'&&attempt?.apiReady===true&&(!instance.workerRequired||attempt.workerAttached===true))
    return 'The runtime is RUNNING and its selected roles passed readiness checks.';
  if(action==='stop'&&state==='STOPPED'&&commandState==='SUCCEEDED'&&attempt?.emptyObserved===true&&attempt.helperClosed===true&&attempt.executionClean===true)
    return 'The runtime is STOPPED with an empty process tree and cleaned execution recorded.';
  if(action==='restart'&&state==='RUNNING'&&commandState==='SUCCEEDED'&&attempt?.apiReady===true&&(!instance.workerRequired||attempt.workerAttached===true))
    return 'The same runtime is RUNNING and its selected roles passed readiness checks.';
  return `${action[0]!.toUpperCase()}${action.slice(1)} result: command ${commandState}; runtime ${state}. Check the retained runtime facts before trying another action.`;
}
function runtimeDetailMatches(detail:ManagedRuntimeInstance| null,instance:any):boolean{
  return Boolean(detail&&detail.id===instance?.id&&detail.currentAttempt===instance?.currentAttempt&&detail.artifactDigest===instance?.artifactDigest&&
    detail.version===instance?.version&&detail.state===instance?.state);
}
function runtimeEvidenceInstance(instance:ManagedRuntimeInstance):ManagedRuntimeInstance{
  const detail=runtimeDetailMatches(selectedRuntime,instance)?selectedRuntime:null;
  if(!detail)return instance;
  return {...instance,
    ...(instance.activeGenerationId===undefined&&detail.activeGenerationId!==undefined?{activeGenerationId:detail.activeGenerationId}:{}),
    ...(instance.attempts===undefined&&detail.attempts!==undefined?{attempts:detail.attempts}:{})};
}
function runtimeGenerationIdentity(instance:ManagedRuntimeInstance):string{return `${instance.currentAttempt}:${instance.activeGenerationId??''}:${instance.artifactDigest}`;}
function compareRuntimeVersions(left:string,right:string):number{
  const a=left.split('.').map(Number),b=right.split('.').map(Number);
  for(let index=0;index<3;index++){const difference=(a[index]??0)-(b[index]??0);if(difference)return difference;}
  return 0;
}
function runtimeHasUpgradeReadyProof(instance:ManagedRuntimeInstance,history:RuntimeUpgradeList|undefined):boolean{
  if(instance.state!=='UPGRADE_READY'||!instance.activeGenerationId||!history||history.instanceId!==instance.id)return false;
  const target=history.generations.find(generation=>generation.id===instance.activeGenerationId);
  const attempt=instance.attempts?.find(item=>item.attempt===instance.currentAttempt) as any;
  if(!target||target.productId!==instance.productId||target.version!==instance.version||target.artifactDigest!==instance.artifactDigest||
    !attempt||attempt.state!=='STOPPED'||attempt.physicalState!=='EMPTY'||attempt.emptyObserved!==true||attempt.helperClosed!==true||attempt.executionClean!==true||
    !attempt.generation?.generationId||attempt.generation.generationId===target.id)return false;
  return history.operations.some(operation=>operation.state==='SUCCEEDED'&&operation.physicalState==='CLEAN'&&operation.sourceGenerationId===attempt.generation.generationId&&
    operation.sourceAttemptId===attempt.id&&operation.sourceAttempt===attempt.attempt&&operation.targetGenerationId===target.id&&operation.destinationPublished===true&&
    operation.destinationVerified===true&&operation.driverEmpty===true&&operation.driverClosed===true&&operation.stagingClean===true&&
    operation.publisherResultObserved===true&&operation.publisherClosed===true);
}

async function api(path:string,method='GET',value?:unknown) {
  const generation=sessionGeneration;
  const response = await fetch(path,{method,credentials:'same-origin',...(method==='GET'?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(value??{})})});
  const body = await response.json();
  if(generation!==sessionGeneration)throw new Error('The local session changed before this response completed');
  if (!response.ok) {
  if (response.status===401) { sessionGeneration++;artifactInspectionGeneration++;artifactInspectionLoading=false;artifactInspectionDigest='';connected=false; data=null;catalogue=null;composed=null;clearProductEditor();productCatalogueSignature='';artifactRegistry=null;artifactRegistryState='idle';artifactRegistryRequest=undefined;artifactLoadError='';selectedArtifact=null;runtimeOverview=null;runtimeReleases=[];runtimeLoadError='';selectedRuntime=null;runtimePending.clear();runtimeRequestKeys.clear();clearRuntimeRecoveryState();buildDetails.clear();loginError='Your local session expired. Pair again to continue.';render(); }
    throw new Error(body.error || 'Local Studio request failed');
  }
  return body;
}
function syncBuildRefresh() {
  const activeBuilds=Boolean(connected&&route==='builds'&&data?.builds.some(build=>Boolean(build.inputDigest)&&['QUEUED','RUNNING','CANCEL_REQUESTED'].includes(build.state)));
  const activeRuntimes=Boolean(connected&&route==='runtime-instances'&&runtimeOverview?.instances.some(instance=>!['STOPPED','UPGRADE_READY','FAILED','PREPARATION_FAILED','REPAIR_REQUIRED'].includes(instance.state)));
  const active=activeBuilds||activeRuntimes;
  if (active&&!refreshTimer) {
    const generation=sessionGeneration;
    refreshTimer=setInterval(()=>{ if(generation!==sessionGeneration)return;
      const refresh=route==='runtime-instances'?loadRuntimeOverview():loadOverview();
      void refresh.catch(error=>{if(generation===sessionGeneration&&connected){actionError=error instanceof Error?error.message:'Unable to refresh local state';render();}});
    },1500);
  }
  if (!active&&refreshTimer) { clearInterval(refreshTimer); refreshTimer=undefined; }
}

function table(headers: string[], rows: unknown[][]) {
  return `<div class="card">${rows.length ? `<table class="table"><thead><tr>${headers.map(header => `<th>${esc(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${esc(show(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing recorded yet.</div>'}</div>`;
}
function loginView() {
  app.innerHTML = `<main class="login-wrap"><form id="pair-form" class="card login-card"><div class="eyebrow">Local operator</div><h1>Connect Studio</h1><p class="muted">Enter the pairing code printed in the Studio terminal. This connects only this browser to the local control plane.</p><label for="pairing-code">Pairing code</label><input id="pairing-code" name="code" type="password" autocomplete="off" required maxlength="128"><button class="primary" type="submit" ${disconnecting?'disabled':''}>Connect local Studio</button>${disconnecting?'<div class="muted" role="status">Disconnecting…</div>':''}${loginError ? `<div class="error" role="alert">${esc(loginError)}</div>` : ''}</form></main>`;
}
function overview() {
  if (!data) return '';
  return `<div class="grid"><div class="card"><h3>Modules</h3><div class="metric">${data.modules.length}</div><div class="muted">reviewed source manifests</div></div><div class="card"><h3>Products</h3><div class="metric">${data.products.length}</div><div class="muted">stored immutable versions</div></div><div class="card"><h3>AI pipelines</h3><div class="metric">${data.aiPipelines.length}</div><div class="muted">validated plan records</div></div><div class="card"><h3>Environments</h3><div class="metric">${data.environments.length}</div><div class="muted">local target records</div></div></div><section class="section"><div class="section-title"><h2>Construction path</h2><span class="badge">Compose → build → inspect local export</span></div><div class="flow"><div class="step">Studio</div><span class="arrow">→</span><div class="step">Product Definition</div><span class="arrow">→</span><div class="step">Composition</div><span class="arrow">→</span><div class="step">Local Build</div><span class="arrow">→</span><div class="step">Verified Snapshot</div></div><p class="muted">Deployment and model-serving remain unattached.</p></section><section class="section"><div class="section-title"><h2>Module declarations</h2></div><div class="layers">${data.coverage.map(layer => `<div class="card layer"><div class="layer-top"><h3>${esc(title(layer.layer))}</h3><span class="status ${layer.implemented ? '' : 'partial'}">${layer.implemented ? 'declared' : 'not selected'}</span></div><p>${esc(layer.detail)}</p><div class="chips">${layer.modules.map(module => `<span class="chip">${esc(module)}</span>`).join('') || '<span class="chip">none declared</span>'}</div></div>`).join('')}</div></section>`;
}

function productsView() {
  if (!data) return '';
  const modules=(catalogue?.modules??[]).map(module=>`<label class="check"><input type="checkbox" name="selected" value="${esc(module.id)}" ${composeDraft.selected.includes(module.id)?'checked':''}><span><strong>${esc(module.id)}</strong><small>${esc(module.version)}${module.studio?.layers?.length?` · ${esc(module.studio.layers.join(', '))}`:''}</small></span></label>`).join('');
  let draft:any=null;try{draft=productEditorText?parseProductEditorText():null;}catch{}
  const enabled=Boolean(productPreview?.valid===true&&productPreviewGeneration===productEditorGeneration&&!productEditorBusy);
  const saved=(data.productVersions??[]).map(product=>{const value=`${product.id}@${product.version}`;return `<option value="${esc(value)}" ${selectedSavedProduct===value?'selected':''}>${esc(value)}${product.valid===false?' · legacy invalid':''}</option>`;}).join('');
  const diagnostics=productEditorDiagnostics.length?`<div class="error" role="alert">${productEditorDiagnostics.map(item=>`<div>${esc(item)}</div>`).join('')}</div>`:'';
  const families=catalogue?.families??[];
  const family=families.find(item=>item.id===selectedFamilyId)??families[0];
  const familySection=family?`<section class="section family-builder"><div class="section-title"><h2>${esc(family.title)}</h2><span class="status">Reviewed product family</span></div><p class="muted">Choose business features. Module versions and local wiring come from the reviewed source catalogue; this creates a draft, not a running product.</p><form id="family-derive-form" class="card form-grid"><label>Product family<select name="familyId" class="input">${families.map(item=>`<option value="${esc(item.id)}" ${item.id===family.id?'selected':''}>${esc(item.title)}</option>`).join('')}</select></label><label>Product ID<input name="id" required maxlength="48" pattern="[a-z][a-z0-9-]{1,47}" value="${esc(familyIdentity.id)}"></label><label>Title<input name="title" required maxlength="80" value="${esc(familyIdentity.title)}"></label><label>Version<input name="version" required maxlength="20" pattern="[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}" value="${esc(familyIdentity.version)}"></label><label>Description<input name="description" maxlength="2000" value="${esc(familyIdentity.description)}"></label><label>Navigation<select name="layout" class="input"><option value="sidebar" ${familyIdentity.layout==='sidebar'?'selected':''}>Sidebar</option><option value="top" ${familyIdentity.layout==='top'?'selected':''}>Top bar</option></select></label><fieldset><legend>Features</legend><div class="checks">${family.features.map((feature:any)=>`<label class="check"><input type="checkbox" name="familyFeature" value="${esc(feature.id)}" ${selectedFamilyFeatures.includes(feature.id)?'checked':''} ${family.requiredFeatureIds.includes(feature.id)?'disabled':''}><span><strong>${esc(feature.label)}</strong><small>${esc(feature.description)}</small></span></label>`).join('')}</div></fieldset><button class="secondary" type="submit" ${familyDeriveBusy?'disabled':''}>${familyDeriveBusy?'Deriving…':'Derive complete definition'}</button></form>${familyDerivation?`<div class="card result-card"><h3>Family derivation</h3><p class="muted">${esc(familyDerivation.familyId)}@${esc(familyDerivation.familyVersion)} · ${esc(familyDerivation.productDigest.slice(0,12))}… · ${esc(familyDerivation.sourceFingerprint.slice(0,12))}…</p><ul>${(familyDerivation.reasons??[]).map((item:any)=>`<li>${esc(item.label)}: ${esc(item.reason)}</li>`).join('')}${(familyDerivation.technicalExplanations??[]).map((item:any)=>`<li>${esc(item.moduleId)}: ${esc(item.reason)}</li>`).join('')}</ul><p class="muted">The complete definition is in the editor below. Preview it and confirm the exact immutable version to save.</p></div>`:''}${savedFamilyDerivation?`<p class="muted" data-family-provenance>Saved from ${esc(savedFamilyDerivation.familyId)}@${esc(savedFamilyDerivation.familyVersion)} with the original source fingerprint.</p>`:''}</section>`:'';
  const graph=enabled&&productPreview.graph?`<div class="product-graph"><h3>Resolved source graph</h3><div class="chips">${productPreview.graph.nodes.map((node:any)=>`<span class="chip">${esc(node.id)}@${esc(node.version)}${node.external?' · reviewed external adapter':''}</span>`).join('')}</div><ul>${productPreview.graph.edges.map((edge:any)=>`<li>${esc(edge.from)} → ${esc(edge.to)} · ${esc(edge.label)}${edge.mode?` · ${esc(edge.mode)} / ${esc(edge.scope)} / ${esc(edge.instanceId)}`:''}</li>`).join('')}</ul></div>`:'';
  const preview=enabled?`<div class="card result-card"><h3>Read-only composition preview</h3><p><strong>${esc(productPreview.product.title)}</strong> · ${esc(productPreview.product.id)}@${esc(productPreview.product.version)}</p><p class="muted">${productPreview.status}. This definition is not running.</p>${graph}<label class="confirm"><input type="checkbox" data-product-save-confirm> Save the exact immutable version ${esc(productPreview.product.id)}@${esc(productPreview.product.version)}.</label><div class="actions"><button class="secondary" data-product-export>Export exact definition</button><button class="primary" data-product-save>Save immutable ${esc(productPreview.product.id)}@${esc(productPreview.product.version)}</button></div></div>`:'';
  const field=(name:string,label:string,max:number)=>`<label>${label}<input data-product-field="${name}" maxlength="${max}" value="${esc(draft?.[name]??'')}" ${!draft?'disabled':''}></label>`;
  const editor=`<section class="section"><div class="section-title"><h2>Product definition editor</h2><span class="status">Complete JSON is authoritative</span></div><p class="muted">Import, edit or load one exact immutable version. The editor preserves every declaration; unsupported values stay visible with diagnostics and cannot be saved or built.</p><div class="product-editor-toolbar"><label>Load saved version<select class="input" id="saved-product-version"><option value="">Choose an exact saved version</option>${saved}</select></label><button class="secondary" data-product-load ${productEditorBusy?'disabled':''}>Load exact version</button><label class="secondary product-file">Import product.json<input type="file" accept="application/json,.json" data-product-import></label></div><div class="product-editor-fields">${field('id','Product ID',48)}${field('title','Title',120)}${field('description','Description',2000)}${field('version','Version',20)}<label>Layout<select data-product-field="layout" ${!draft?'disabled':''}><option value="sidebar" ${draft?.layout==='sidebar'?'selected':''}>Sidebar</option><option value="top" ${draft?.layout==='top'?'selected':''}>Top</option></select></label></div><label class="product-json-label">Complete ProductDefinition JSON<textarea id="product-json" data-product-json rows="18" maxlength="65536" spellcheck="false" placeholder="Use New composition below or import a complete product.json">${esc(productEditorText)}</textarea></label><div class="product-editor-arrays"><label>Exact module references<textarea data-product-array="modules" rows="7" ${!draft?'disabled':''}>${esc(productEditorArrayDrafts.modules??JSON.stringify(draft?.modules??[],null,2))}</textarea></label><label>Exact public bindings<textarea data-product-array="bindings" rows="9" ${!draft?'disabled':''}>${esc(productEditorArrayDrafts.bindings??JSON.stringify(draft?.bindings??[],null,2))}</textarea></label></div>${diagnostics}<div class="actions"><button class="primary" data-product-preview ${!productEditorText||productEditorBusy||productEditorDiagnostics.length?'disabled':''}>${productEditorBusy?'Checking…':'Preview exact definition'}</button>${enabled?'<span class="muted">Preview matches the current edit and paired session.</span>':''}</div>${preview}</section>`;
  const starter=`<details class="card product-starter"><summary>New composition starter</summary><p class="muted">This creates a starter definition only. Review and edit the complete JSON above before previewing, saving or building.</p><form id="compose-form" class="form-grid"><label>Product ID<input name="id" required pattern="[a-z][a-z0-9-]{1,47}" maxlength="48" placeholder="my-product" value="${esc(composeDraft.id)}"></label><label>Title<input name="title" required maxlength="80" placeholder="My product" value="${esc(composeDraft.title)}"></label><label>Version<input name="version" required pattern="[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}" value="${esc(composeDraft.version)}" maxlength="20"></label><label>Navigation<select name="layout"><option value="sidebar" ${composeDraft.layout==='sidebar'?'selected':''}>Sidebar</option><option value="top" ${composeDraft.layout==='top'?'selected':''}>Top bar</option></select></label><fieldset><legend>Reviewed modules</legend><div class="checks">${modules||'<span class="muted">No modules are available.</span>'}</div></fieldset><button class="secondary" type="submit">Create starter in editor</button></form></details>`;
  return `${actionError?`<div class="error" role="alert">${esc(actionError)}</div>`:''}${familySection}${starter}${editor}<section class="section"><h2>Saved immutable versions</h2>${table(['Product','Title','Version','Modules','Admission'],data.productVersions.map(product=>[product.id,product.title,product.version,product.modules,product.valid===false?'legacy invalid':'valid']))}</section>`;
 }
function buildsView() {
  if (!data) return '';
  const buildableVersions=data.productVersions.filter(product=>product.valid!==false);
  return `<p class="muted">Build requests run the fixed local compile and export recipe. Cancellation is available while work is active.</p>${actionError?`<div class="error" role="alert">${esc(actionError)}</div>`:''}<section class="section">${data.builds.length?data.builds.map(build=>{const legacy=!build.inputDigest;const verified=Boolean(build.inputDigest&&build.snapshotId&&build.snapshotDigest);return `<article class="card build-card"><div class="layer-top"><div><h3>${esc(build.productId)}@${esc(build.version)}</h3><div class="muted">${esc(build.id)} · attempt ${esc(build.attempt??0)}</div></div><span class="status ${build.state==='SUCCEEDED'?'':'partial'}">${esc(build.state)}</span></div>${legacy?'<p class="muted">Legacy admission only; not executable. No locally verified export is associated with this record.</p>':`<p>${esc(build.phase??'')}</p>`}${build.failureMessage?`<p class="error">${esc(build.failureCode??'BUILD_FAILED')}: ${esc(build.failureMessage)}</p>`:''}<div class="actions">${build.state==='SUCCEEDED'&&verified?`<button class="secondary" data-result="${esc(build.id)}">Inspect verified export</button>`:''}${!legacy&&['QUEUED','RUNNING','CANCEL_REQUESTED'].includes(build.state)?`<button class="secondary" data-cancel="${esc(build.id)}">Cancel build</button>`:''}<button class="secondary" data-log="${esc(build.id)}">View log</button></div>${buildDetails.has(build.id)?`<pre class="detail">${esc(buildDetails.get(build.id))}</pre>`:''}</article>`}).join(''):'<div class="card empty">No build requests yet.</div>'}</section><section class="section"><h2>Request a local build</h2><p class="muted">Confirm each request. A new idempotency key starts a distinct bounded build request.</p><div class="build-products">${buildableVersions.map(product=>`<article class="card build-request-card"><h3>${esc(product.title)}</h3><p class="muted">${esc(product.id)}@${esc(product.version)} · ${product.modules} modules</p><label class="confirm"><input type="checkbox" data-build-confirm> I want to compile and export this product locally.</label><button class="primary" data-request-build="${esc(product.id)}" data-version="${esc(product.version)}">Request build</button></article>`).join('')||'<div class="card empty">No valid saved product versions are available to build.</div>'}</div></section>`;
}
function artifactsView() {
  if(artifactRegistryState==='idle'||artifactRegistryState==='loading')return `<div class="card" role="status">Loading local artifact registry…</div>`;
  if(artifactRegistryState==='error'||!artifactRegistry)return `<div class="error" role="alert">${esc(artifactLoadError||'The local artifact registry could not be loaded.')}</div><button class="secondary" data-retry-artifact-registry>Retry</button>`;
  const capability=artifactRegistry.capability??{};
  const capacity=artifactRegistry.capacity??{};
  const artifacts=artifactRegistry.artifacts??[];
  const selected=selectedArtifact;
  const operationRows=(artifactRegistry.operations??[]).map((operation:any)=>[
    operation.created?new Date(operation.created).toLocaleString():'—',operation.kind,operation.state,operation.physicalState,
    operation.destinationVerified?'verified':'unverified',operation.stagingClean?'clean':'not verified clean',
    operation.ownerObservation==='not-observed-in-this-process'?'owner not observed here; reservation retained':operation.ownerObservation==='initiated-in-this-process'?'initiated here':'—',
    `${operation.productId??'—'}@${operation.version??'—'}`,operation.errorMessage??'—']);
  const cards=artifacts.length?artifacts.map((artifact:any)=>`<article class="card artifact-card"><div class="layer-top"><div><h3>${esc(artifact.productId)}@${esc(artifact.version)}</h3><div class="muted">Build ${esc(artifact.buildId)}</div></div><span class="status">registered</span></div><p class="digest">Snapshot ${esc(artifact.digest)}</p><p class="muted">${esc(artifact.fileCount)} files · ${esc(artifact.sizeBytes)} bytes · registered ${esc(new Date(artifact.registeredAt).toLocaleString())}</p><div class="actions"><button class="secondary" data-inspect-artifact="${esc(artifact.digest)}">Verify and inspect</button></div><label class="confirm"><input type="checkbox" data-promote-confirm> Promote exactly ${esc(artifact.productId)}@${esc(artifact.version)} as a local immutable release.</label><button class="primary" data-promote-artifact="${esc(artifact.digest)}" data-product="${esc(artifact.productId)}" data-version="${esc(artifact.version)}">Promote local release</button></article>`).join(''):'<div class="card empty">No verified local artifacts are registered.</div>';
  const registerable=(data?.builds??[]).filter((build:any)=>build.state==='SUCCEEDED'&&build.inputDigest&&build.snapshotDigest&&!artifacts.some((artifact:any)=>artifact.digest===build.snapshotDigest));
  const registerCards=registerable.map((build:any)=>`<article class="card artifact-card"><h3>${esc(build.productId)}@${esc(build.version)}</h3><p class="muted">Successful build ${esc(build.id)}</p><p class="digest">Snapshot ${esc(build.snapshotDigest)}</p><label class="confirm"><input type="checkbox" data-register-confirm> I verified this exact build and want to copy it into the local artifact registry.</label><button class="primary" data-register-artifact="${esc(build.id)}" ${capability.status!=='ready'?'disabled':''}>Register verified build</button></article>`).join('');
  const entryRows=selected?.entries??[];
  const inspectionPanel=artifactInspectionLoading?`<section class="section"><div class="section-title"><h2>Verifying artifact details</h2><button class="secondary" data-close-artifact>Close details</button></div><p class="digest">${esc(artifactInspectionDigest)}</p><div class="card" role="status">Loading verified inventory…</div></section>`:'';
  const detailTable=selected?`<section class="section"><div class="section-title"><h2>Verified inventory: ${esc(selected.productId)}@${esc(selected.version)}</h2><button class="secondary" data-close-artifact>Close details</button></div><p class="digest">${esc(selected.digest)}</p><p class="muted">Verified files are downloaded as attachments and never run in the operator origin.</p><div class="card">${entryRows.length?`<table class="table"><thead><tr><th>Relative file</th><th>SHA-256</th><th>Bytes</th><th>Action</th></tr></thead><tbody>${entryRows.map((entry:any)=>`<tr><td>${esc(entry.path)}</td><td class="digest">${esc(entry.digest)}</td><td>${esc(entry.sizeBytes)}</td><td><a class="secondary artifact-download" href="/platform-api/artifacts/${esc(selected.digest)}/entries/${esc(entry.id)}" download>Download</a></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No files are present.</div>'}</div></section>`:'';
  return `${actionError?`<div class="error" role="alert">${esc(actionError)}</div>`:''}<section class="section"><div class="section-title"><h2>Local artifact registry</h2><span class="status ${capability.status==='ready'?'':'partial'}">publication ${esc(capability.status??'unavailable')}</span></div><div class="card"><p>${esc(capability.detail??'Registry status unavailable.')}</p><p class="muted">Physical publication is separate from reading and promoting registered artifacts. Promoted releases can be started through Managed local runtime. Deployment and provider actions remain unattached.</p><div class="chips"><span class="chip">${esc(capacity.objectDirectories??0)} / ${esc(artifactRegistry.limits?.maxObjectDirectories??0)} object directories</span><span class="chip">${esc(capacity.registryBytes??0)} / ${esc(artifactRegistry.limits?.maxRegistryBytes??0)} registry bytes</span><span class="chip">${esc(capacity.stagingBytes??0)} / ${esc(artifactRegistry.limits?.maxStagingBytes??0)} staging bytes</span><span class="chip">${esc(capacity.reservedBytes??0)} reserved bytes</span></div></div></section><section class="section"><h2>Successful builds ready for registration</h2><p class="muted">Registration verifies and copies the exact immutable snapshot digest.</p><div class="build-products">${registerCards||'<div class="card empty">No unregistered successful builds are available.</div>'}</div></section><section class="section"><h2>Registered immutable artifacts</h2><div class="build-products">${cards}</div></section>${inspectionPanel}${detailTable}<section class="section"><h2>Recent registry operations</h2><p class="muted">Showing up to ${esc(artifactRegistry.operationHistory?.limit??200)} of ${esc(artifactRegistry.operationHistory?.count??0)} records${artifactRegistry.operationHistory?.truncated?' (history truncated)':''}.</p>${table(['Started','Kind','State','Physical proof','Destination','Staging','Local owner observation','Product','Last issue'],operationRows)}</section><section class="section"><h2>Promoted local releases</h2>${table(['Product','Version','Artifact','Promoted by','At'],(artifactRegistry.releases??[]).map((release:any)=>[release.productId,release.version,release.artifactDigest,release.promotingActorId,new Date(release.promotedAt).toLocaleString()]))}</section>`;
}
function runtimeView() {
  if(!runtimeOverview)return `${runtimeLoadError?`<div class="error" role="alert">${esc(runtimeLoadError)}</div>`:''}<div class="card">${runtimeLoadError?'Local runtime state could not be loaded.':'Loading managed local runtimes…'} ${runtimeLoadError?'<button class="secondary" data-retry-runtime>Retry</button>':''}</div>`;
  const instances=runtimeOverview.instances??[];
  const releaseCards=runtimeReleases.map(release=>{
    const key=`START:${release.productId}@${release.version}:${release.artifactDigest}`,busy=runtimePending.has(key);
    return `<article class="card runtime-card"><div class="layer-top"><div><h3>${esc(release.productId)}@${esc(release.version)}</h3><div class="muted">Promoted local immutable release</div></div><span class="status">promoted</span></div><p class="digest">${esc(release.artifactDigest)}</p><label class="confirm"><input type="checkbox" data-runtime-confirmation="${esc(key)}" data-runtime-start-confirm ${busy?'disabled':''}> Start this exact promoted local release on this machine.</label><button class="primary" data-runtime-start data-product="${esc(release.productId)}" data-version="${esc(release.version)}" ${busy?'disabled':''}>${busy?'Starting…':'Start local runtime'}</button></article>`;
  }).join('');
  const runtimeCards=instances.map(instance=>{
    const evidenceInstance=runtimeEvidenceInstance(instance);
    const actionIdentity=`${instance.id}:${instance.currentAttempt}:${instance.artifactDigest}`;
    const busy=runtimePending.has(`STOP:${actionIdentity}`)||runtimePending.has(`RESTART:${actionIdentity}`);
    const canStop=instance.state==='RUNNING'&&instance.processObservation==='owned-in-this-process';
    const historyEntry=runtimeUpgradeLists.get(instance.id),history=historyEntry?.identity===runtimeGenerationIdentity(instance)?historyEntry.value:undefined;
    const currentGeneration=history?.generations.find(generation=>generation.id===evidenceInstance.activeGenerationId&&generation.productId===instance.productId&&
      generation.version===instance.version&&generation.artifactDigest===instance.artifactDigest);
    const upgradeReadyRestart=runtimeHasUpgradeReadyProof(evidenceInstance,history);
    const canRestart=(instance.state==='STOPPED'&&instance.processObservation==='positively-stopped')||upgradeReadyRestart;
    const selected=runtimeDetailMatches(selectedRuntime,instance)?selectedRuntime:null;
    const clientIdentity=`${instance.id}:${evidenceInstance.activeGenerationId??''}:${instance.currentAttempt}:${instance.artifactDigest}`;
    const canPackage=Boolean(selected&&evidenceInstance.activeGenerationId&&selected.activeGenerationId===evidenceInstance.activeGenerationId&&
      selected.nativeApiProfile==='local-native-forwarded-v1'&&['RUNNING','STOPPED'].includes(instance.state));
    const clientBusy=runtimePending.has(`ANDROID_CLIENT:${clientIdentity}`),clientResult=runtimeAndroidClients.get(clientIdentity);
    const clientPanel=canPackage?`<section class="section runtime-android-client"><h4>Android client for this managed generation</h4>
      <p class="muted">Native API profile: ${esc(selected!.nativeApiProfile)} · model profile: ${esc(selected!.modelAnswerProfile??'not selected')}</p>
      ${selected!.credentialFile?`<p>Private sign-in file: <code>${esc(selected!.credentialFile)}</code>. Open this file on this computer and use the same account in the browser and Android app. Passwords are not shown here.</p>`:''}
      <label class="confirm"><input type="checkbox" data-runtime-confirmation="ANDROID_CLIENT:${esc(clientIdentity)}" data-runtime-android-client-confirm ${clientBusy?'disabled':''}> Create a client for generation ${esc(evidenceInstance.activeGenerationId)}, ${esc(instance.productId)}@${esc(instance.version)}, artifact ${esc(instance.artifactDigest)}.</label>
      <button class="secondary" data-runtime-android-client="${esc(instance.id)}" data-generation="${esc(evidenceInstance.activeGenerationId)}" data-artifact-digest="${esc(instance.artifactDigest)}" ${clientBusy?'disabled':''}>${clientBusy?'Creating Android client…':'Create Android client'}</button>
      ${clientResult&&clientResult.generationId===evidenceInstance.activeGenerationId&&clientResult.artifactDigest===instance.artifactDigest?`<div class="card"><p>Captured client: ${esc(clientResult.productVersion)} · ${esc(clientResult.generationId)} · ${esc(clientResult.artifactDigest)}</p><p>Private output: <code>${esc(clientResult.outputDir)}</code></p><p>Client reference: <code>${esc(clientResult.clientReference)}</code></p><p>Build and install with the selected local profile: <code>npm run local:android:build -- --client ${esc(clientResult.clientReference)}</code>, then <code>npm run local:android:install -- --client ${esc(clientResult.clientReference)}</code>.</p></div>`:''}
      </section>`:'';
    const detail=selected?`<pre class="detail">${esc(selected.events??'(No public runtime events were recorded.)')}</pre>`:'';
    const localUrl=selected?.url??instance.url;
    const recovery=runtimeRecoveryLists.get(actionIdentity),recoveryError=runtimeRecoveryErrors.get(actionIdentity);
    const canRecover=runtimeHasStoppedProof(instance);
    const recoveryBusy=runtimePending.has(`BACKUP:${actionIdentity}`);
    const recoveryRows=(recovery?.backups??[]).map(backup=>{
      const verification=runtimeBackupVerifications.get(backup.digest),restoreKey=`RESTORE:${actionIdentity}:${backup.digest}`;
      const restoreBusy=runtimePending.has(restoreKey);
      const exactVerification=verification?.verified===true&&verification.digest===backup.digest&&verification.instanceId===instance.id;
      const exactSource=currentGeneration&&backup.instanceId===instance.id&&backup.generationId===currentGeneration.id&&backup.attempt===instance.currentAttempt&&
        backup.artifactDigest===currentGeneration.artifactDigest&&backup.version===currentGeneration.version;
      const upgradeTargets=runtimeReleases.filter(release=>release.productId===instance.productId&&compareRuntimeVersions(release.version,instance.version)>0);
      const targetIdentity=`${instance.id}:${backup.digest}`;
      const options=upgradeTargets.map(release=>({value:`${release.version}|${release.artifactDigest}`,release}));
      const selectedValue=options.find(option=>option.value===runtimeUpgradeTargets.get(targetIdentity))?.value??options[0]?.value??'';
      const selectedTarget=options.find(option=>option.value===selectedValue)?.release;
      const upgradeIntent=currentGeneration&&selectedTarget?createRuntimeUpgradeIntent(instance,currentGeneration,backup,selectedTarget):null;
      const upgradeBusy=Boolean(upgradeIntent&&runtimePending.has(upgradeIntent.instanceLockKey));
      const upgradeKey=upgradeIntent?.requestIdentity??`UPGRADE:${actionIdentity}:${backup.digest}:${selectedValue}`;
      const upgradeControls=canRecover&&exactSource&&exactVerification&&upgradeTargets.length&&selectedTarget?`<div class="upgrade-confirmation"><label>Promoted target release<select class="input" data-runtime-upgrade-target="${esc(targetIdentity)}" ${upgradeBusy?'disabled':''}>${options.map(option=>`<option value="${esc(option.value)}" ${option.value===selectedValue?'selected':''}>${esc(option.release.productId)}@${esc(option.release.version)} · ${esc(option.release.artifactDigest)}</option>`).join('')}</select></label><label class="confirm"><input type="checkbox" data-runtime-confirmation="${esc(upgradeKey)}" data-runtime-upgrade-confirm ${upgradeBusy?'disabled':''}> Upgrade this stopped generation ${esc(currentGeneration.generation)} using verified backup ${esc(backup.digest)} to ${esc(selectedTarget.version)} (${esc(selectedTarget.artifactDigest)}).</label><button class="primary" data-runtime-upgrade="${esc(instance.id)}" data-backup-digest="${esc(backup.digest)}" ${upgradeBusy?'disabled':''}>${upgradeBusy?'Upgrading…':'Upgrade exact stopped generation'}</button></div>`:'';
      return `<article class="card recovery-backup"><div class="layer-top"><div><strong>Backup from attempt ${esc(backup.attempt)}</strong><div class="digest">${esc(backup.digest)}</div></div><span class="status ${exactVerification?'':'partial'}">${exactVerification?'verified':'not verified'}</span></div><p class="muted">Generation ${esc(backup.generationId??'unknown')} · ${esc(backup.fileCount)} files · ${esc(backup.sizeBytes)} bytes · ${esc(new Date(backup.capturedAt).toLocaleString())}</p><div class="actions"><button class="secondary" data-runtime-backup-verify="${esc(backup.digest)}" data-runtime-instance="${esc(instance.id)}">${exactVerification?'Verify again':'Verify backup'}</button></div>${exactVerification?`<label class="confirm"><input type="checkbox" data-runtime-confirmation="${esc(restoreKey)}" data-runtime-restore-confirm ${restoreBusy?'disabled':''}> Restore these verified bytes into the absent runtime data location.</label><button class="secondary" data-runtime-restore="${esc(instance.id)}" data-backup-digest="${esc(backup.digest)}" ${restoreBusy?'disabled':''}>${restoreBusy?'Restoring…':'Restore this backup'}</button>`:''}${upgradeControls}</article>`;
    }).join('');
    const recoveryPanel=canRecover?`<section class="section runtime-recovery"><h4>Private local recovery</h4><p class="muted">Recovery is available only after the current attempt has positive stop and cleanup proof. Backups contain private runtime data and are not downloadable.</p>${recoveryError?`<div class="error" role="alert">${esc(recoveryError)}</div>`:''}<div class="actions"><button class="secondary" data-runtime-backups-load="${esc(instance.id)}" ${runtimePending.has(`LIST:${actionIdentity}`)?'disabled':''}>${runtimePending.has(`LIST:${actionIdentity}`)?'Loading…':'Load backups'}</button>${recovery?.capability?.status==='ready'?`<label class="confirm"><input type="checkbox" data-runtime-confirmation="BACKUP:${esc(actionIdentity)}" data-runtime-backup-confirm ${recoveryBusy?'disabled':''}> Create a private backup of this exact stopped runtime.</label><button class="secondary" data-runtime-backup-create="${esc(instance.id)}" ${recoveryBusy?'disabled':''}>${recoveryBusy?'Creating…':'Create backup'}</button>`:''}</div>${recovery?.capability?.status&&recovery.capability.status!=='ready'?`<p class="muted">${esc(recovery.capability.detail||'The fixed local recovery profile is unavailable.')}</p>`:''}${recovery?`<div class="build-products">${recoveryRows||'<div class="card empty">No private backups are recorded for this runtime.</div>'}</div><h4>Recent recovery operations</h4>${table(['Kind','State','Physical state','Destination','Staging','Issue'],(recovery.operations??[]).map(operation=>[operation.kind,operation.state,operation.physicalState,operation.destinationVerified?'verified':'unverified',operation.stagingClean?'clean':'not verified clean',operation.errorCode??'—']))}`:''}</section>`:'';
      const generationHistory=history?`<section class="section runtime-generations"><h4>Immutable generations</h4><div class="card"><ul>${history.generations.map(generation=>`<li>Generation ${esc(generation.generation)} · ${esc(generation.productId)}@${esc(generation.version)} · ${esc(generation.artifactDigest)} · ${generation.id===evidenceInstance.activeGenerationId?esc(instance.state==='UPGRADE_READY'?'current target, not started':'current'): 'retained'}</li>`).join('')}</ul>${history.operations.length?`<h4>Upgrade history</h4><ul>${history.operations.map(operation=>`<li>${esc(operation.state)} · generation ${esc(operation.sourceGenerationId)} → ${esc(operation.targetGenerationId??operation.targetVersion)} · backup ${esc(operation.sourceBackupDigest)}${operation.errorCode?` · ${esc(operation.errorCode)}`:''}</li>`).join('')}</ul>`:'<p class="muted">No upgrade operations are recorded.</p>'}</div></section>`:runtimeUpgradeErrors.has(instance.id)?`<div class="error" role="alert">Generation history unavailable: ${esc(runtimeUpgradeErrors.get(instance.id))}</div>`:'<p class="muted">Loading immutable generation and upgrade history…</p>';
    const upgradeReadyNotice=upgradeReadyRestart?'<p class="muted">The target generation is verified and cut over, but has not been started. No target readiness or application address is recorded yet.</p>':'';
    return `<article class="card runtime-card"><div class="layer-top"><div><h3>${esc(instance.productId)}@${esc(instance.version)}</h3><div class="muted">${esc(instance.id)} · attempt ${esc(instance.currentAttempt)}${evidenceInstance.activeGenerationId?` · generation ${esc(evidenceInstance.activeGenerationId)}`:''}</div></div><span class="status ${instance.state==='RUNNING'?'':'partial'}">${esc(instance.state)}</span></div><p class="digest">Artifact ${esc(instance.artifactDigest)}</p><p class="muted">${instance.workerRequired?'Separate worker required':'No separate worker required'} · ${esc(instance.processObservation)}</p>${upgradeReadyNotice}${instance.operationalError?`<p class="error">${esc(instance.operationalError)}</p>`:''}${instance.controlWarning?`<p class="muted">${esc(instance.controlWarning)}</p>`:''}${localUrl&&instance.state==='RUNNING'?`<p><a class="secondary" href="${esc(localUrl)}" target="_blank" rel="noreferrer">Open local application</a></p>`:''}<div class="actions"><button class="secondary" data-runtime-detail="${esc(instance.id)}">${selected?'Refresh events and address':'Inspect runtime'}</button>${canStop?`<label class="confirm"><input type="checkbox" data-runtime-confirmation="STOP:${esc(actionIdentity)}" data-runtime-action-confirm ${busy?'disabled':''}> Stop this exact local runtime and retain its data.</label><button class="secondary" data-runtime-stop="${esc(instance.id)}" data-attempt="${esc(instance.currentAttempt)}" data-artifact-digest="${esc(instance.artifactDigest)}" ${busy?'disabled':''}>${busy?'Stopping…':'Stop runtime'}</button>`:''}${canRestart?`<label class="confirm"><input type="checkbox" data-runtime-confirmation="RESTART:${esc(actionIdentity)}" data-runtime-action-confirm ${busy?'disabled':''}> Restart this exact ${upgradeReadyRestart?'target generation':'stopped instance'} and release.</label><button class="primary" data-runtime-restart="${esc(instance.id)}" data-attempt="${esc(instance.currentAttempt)}" data-artifact-digest="${esc(instance.artifactDigest)}" ${busy?'disabled':''}>${busy?'Restarting…':upgradeReadyRestart?'Start upgraded generation':'Restart exact runtime'}</button>`:''}</div>${detail}${clientPanel}${generationHistory}${recoveryPanel}</article>`;
  }).join('');
  const slot=runtimeOverview.slot??{state:'UNKNOWN',instanceId:null,reservedBytes:0};
  return `${runtimeLoadError?`<div class="error" role="alert">${esc(runtimeLoadError)}</div>`:''}${actionError?`<div class="error" role="alert">${esc(actionError)}</div>`:''}<section class="section"><div class="section-title"><h2>Managed local runtime</h2><span class="status">${esc(runtimeOverview.capability.status)}</span></div><div class="card"><p>${esc(runtimeOverview.capability.details)}</p><p class="muted">Physical slot: ${esc(slot.state)}${slot.instanceId?` · ${esc(slot.instanceId)}`:''} · ${esc(slot.reservedBytes)} reserved bytes. UNKNOWN retains the slot and data until its original process owner proves an empty process tree.</p><p class="muted">A fixed local process starts only an exact promoted release. No hosted deployment or provider is attached.</p></div></section><section class="section"><h2>Promoted releases</h2><p class="muted">Choose the exact product version; start and restart require confirmation.</p><div class="build-products">${releaseCards||'<div class="card empty">No promoted local releases are available.</div>'}</div></section><section class="section"><h2>Runtime instances</h2><div class="build-products">${runtimeCards||'<div class="card empty">No managed local runtime instances have been started.</div>'}</div></section>`;
}
function renderRoute() {
  if (!data) return '<div class="card">Loading platform state…</div>';
  switch (route) {
    case 'overview': return overview();
    case 'products': return productsView();
    case 'modules': return table(['Module', 'Version', 'Workspaces', 'Routes', 'AI declarations', 'Data stores'], data.modules.map(module => [module.id, module.version, module.workspaces, module.routes, module.aiPipelines, module.dataStores]));
    case 'ui': return table(['Module', 'Workspaces', 'UI metadata'], data.modules.filter(module => module.workspaces || module.layers.includes('ui')).map(module => [module.id, module.workspaces, module.layers.includes('ui') ? 'declared' : 'legacy workspace']));
    case 'backend': return table(['Module', 'Routes', 'Provides', 'Requires'], data.modules.map(module => [module.id, module.routes, module.provides, module.requires]));
    case 'ai': return `${table(['Pipeline', 'Version', 'Plan stages', 'Required capabilities'], data.aiPipelines.map(pipeline => [pipeline.id, pipeline.version, pipeline.stages, pipeline.capabilities]))}<section class="section"><div class="card"><h3>AI boundary</h3><p class="muted">Pipelines are validated as DAG plans. The local control plane does not call a model provider or run inference.</p></div></section>`;
    case 'data': return table(['Module', 'Declared stores', 'Current schema'], data.modules.map(module => [module.id, module.dataStores, module.schema]));
    case 'builds': return buildsView();
    case 'artifacts': return artifactsView();
    case 'runtime-instances': return runtimeView();
    case 'environments': return table(['Environment', 'Kind', 'Target', 'Region'], data.environments.map(environment => [environment.id, environment.kind, environment.target, environment.region || '—']));
    case 'deployments': return table(['Deployment request', 'Environment', 'Product', 'Version', 'Build', 'Admission state'], data.deployments.map(deployment => [deployment.id, deployment.environmentId, deployment.productId, deployment.version, deployment.buildId, deployment.state]));
    case 'audit': return table(['At', 'Actor reference', 'Action', 'Subject', 'Recorded details'], data.audit.map(item => [new Date(item.at).toLocaleString(), item.actorId ?? 'unknown (legacy)', item.action, item.subject, item.payload]));
    case 'operations': return `<div class="layers">${data.capabilities.map(capability => `<div class="card"><div class="layer-top"><h3>${esc(title(capability.id))}</h3><span class="status ${capability.status === 'attached' ? '' : 'partial'}">${esc(capability.status)}</span></div><p class="muted">${esc(capability.detail)}</p></div>`).join('')}</div>`;
    default: return overview();
  }
}
function render() {
  if (!connected || !data) { syncBuildRefresh();loginView();return; }
  const runtimeChecks=new Map<string,boolean>();
  for(const input of app.querySelectorAll<HTMLInputElement>('[data-runtime-confirmation]'))runtimeChecks.set(input.dataset.runtimeConfirmation!,input.checked);
  app.innerHTML = `<div class="shell"><aside class="side"><div class="brand">Quadbridge Product Studio<small>Paired local operator</small></div><nav class="nav">${nav.map(item => `<button data-route="${item}" class="${route === item ? 'active' : ''}">${esc(title(item))}</button>`).join('')}</nav></aside><main class="main"><header class="head"><div><div class="eyebrow">${esc(data.platform.mode)}</div><h1>${esc(title(route))}</h1><div class="muted">Stored source records and validated local plans.</div></div><div class="head-actions"><span class="badge">v${esc(data.platform.version)}</span><button class="secondary" data-logout>Disconnect</button></div></header>${renderRoute()}</main></div>`;
  for(const input of app.querySelectorAll<HTMLInputElement>('[data-runtime-confirmation]'))if(runtimeChecks.has(input.dataset.runtimeConfirmation!))input.checked=runtimeChecks.get(input.dataset.runtimeConfirmation!)!;
  syncBuildRefresh();
}
async function loadOverview() {
  const generation=sessionGeneration;
  const current=overviewRefreshes.get(generation);
  if(current)return current;
  const pending=(async()=>{
    const body=await api('/platform-api/overview');
    if(generation!==sessionGeneration)return;
    data=body as Overview;connected=true;loginError='';render();
    if(route==='products')void loadCatalogue().then(()=>{if(generation===sessionGeneration&&connected)render();}).catch(error=>{if(generation===sessionGeneration&&connected){actionError=error instanceof Error?error.message:'Catalogue unavailable';render();}});
    if(route==='artifacts')void loadArtifactRegistry().catch(error=>{if(generation===sessionGeneration&&connected){artifactLoadError=error instanceof Error?error.message:'Artifact registry unavailable';render();}});
    if(route==='runtime-instances')void loadRuntimeOverview().catch(error=>{if(generation===sessionGeneration&&connected){runtimeLoadError=error instanceof Error?error.message:'Runtime state unavailable';render();}});
  })();
  overviewRefreshes.set(generation,pending);
  try { await pending; }
  finally { if(overviewRefreshes.get(generation)===pending)overviewRefreshes.delete(generation); }
}
async function loadCatalogue() {
  if (!catalogue) {
    const next=await api('/platform-api/catalogue');
    const signature=JSON.stringify([next.modules,next.solutions,next.families??[]]);
    if(productCatalogueSignature&&productCatalogueSignature!==signature)invalidateProductEditor();
    productCatalogueSignature=signature;catalogue=next;
    if(!selectedFamilyId||!(next.families??[]).some((item:any)=>item.id===selectedFamilyId)){
      const first=(next.families??[])[0];selectedFamilyId=first?.id??'';selectedFamilyFeatures=first?[...first.defaultFeatureIds]:[];
    }
  }
  return catalogue;
}
function loadProductsForNavigation(generation:number,navigation:number){
  void loadCatalogue().then(()=>{
    if(generation===sessionGeneration&&connected&&navigation===navigationGeneration&&route==='products')render();
  }).catch(error=>{
    if(generation===sessionGeneration&&connected&&navigation===navigationGeneration&&route==='products'){
      actionError=error instanceof Error?error.message:'Catalogue unavailable';render();
    }
  });
}
async function loadArtifactRegistry() {
  const session=sessionGeneration,navigation=navigationGeneration;
  if(!connected||route!=='artifacts')return;
  if(artifactRegistryRequest?.session===session&&artifactRegistryRequest.navigation===navigation)return artifactRegistryRequest.promise;
  artifactRegistry=null;artifactLoadError='';artifactRegistryState='loading';render();
  const token={};
  const promise=(async()=>{
    try{
      const value=await api('/platform-api/artifacts');
      if(session!==sessionGeneration||!connected||navigation!==navigationGeneration||route!=='artifacts')return;
      artifactRegistry=value;artifactLoadError='';artifactRegistryState='ready';render();
    }catch(error){
      if(session===sessionGeneration&&connected&&navigation===navigationGeneration&&route==='artifacts'){
        artifactRegistry=null;artifactLoadError=error instanceof Error?error.message:'Artifact registry unavailable';artifactRegistryState='error';render();
      }
    }finally{if(artifactRegistryRequest?.token===token)artifactRegistryRequest=undefined;}
  })();
  artifactRegistryRequest={session,navigation,token,promise};
  return promise;
}
function activateRoute(nextRoute:string,writeHash=false){
  const previousRoute=route;
  if(nextRoute===route&&!writeHash)return;
  route=nextRoute;navigationGeneration++;
  if(previousRoute==='products'&&route!=='products'){invalidateProductEditor();familyDeriveBusy=false;}
  if(previousRoute==='artifacts'||route==='artifacts'){
    artifactInspectionGeneration++;artifactInspectionLoading=false;artifactInspectionDigest='';selectedArtifact=null;actionError='';
    if(route==='artifacts'){artifactRegistry=null;artifactRegistryState='idle';artifactLoadError='';}
  }
  if(writeHash&&location.hash.slice(1)!==route)location.hash=route;
  if(connected)render();
  if(!connected)return;
  const session=sessionGeneration,navigation=navigationGeneration;
  if(route==='products')loadProductsForNavigation(session,navigation);
  if(route==='artifacts')void loadArtifactRegistry();
  if(route==='runtime-instances'){
    runtimeLoadError='';void loadRuntimeOverview().catch(error=>{if(session===sessionGeneration&&connected&&navigation===navigationGeneration){runtimeLoadError=error instanceof Error?error.message:'Runtime state unavailable';render();}});
  }
}
async function loadRuntimeOverview() {
  const generation=sessionGeneration;
  const navigation=navigationGeneration,sequence=++runtimeOverviewSequence;
  let runtime:unknown,releases:RuntimeRelease[];
  try {
    [runtime,releases]=await Promise.all([api('/platform-api/runtime-instances'),api('/platform-api/releases')]);
  } catch(error) {
    if(generation!==sessionGeneration||!connected||navigation!==navigationGeneration||route!=='runtime-instances'||sequence!==runtimeOverviewSequence)return;
    throw error;
  }
  if(generation!==sessionGeneration||!connected||navigation!==navigationGeneration||route!=='runtime-instances'||sequence!==runtimeOverviewSequence)return;
  const next=runtime as RuntimeOverview;
  if(selectedRuntime&&!next.instances.some(instance=>runtimeDetailMatches(selectedRuntime,instance)))selectedRuntime=null;
  runtimeOverview=next;runtimeReleases=releases;runtimeLoadError='';render();
  for(const instance of next.instances)void loadRuntimeUpgradeHistory(instance,generation,navigation);
}
async function loadRuntimeUpgradeHistory(instance:ManagedRuntimeInstance,generation:number,navigation:number){
  const identity=runtimeGenerationIdentity(instance),requestIdentity=`${instance.id}:${identity}`;
  if(runtimeUpgradeLists.get(instance.id)?.identity===identity||runtimeUpgradeRequests.has(requestIdentity))return;
  runtimeUpgradeRequests.add(requestIdentity);
  try{
    const value=await api(`/platform-api/runtime-instances/${encodeURIComponent(instance.id)}/upgrades`) as RuntimeUpgradeList;
    const current=runtimeOverview?.instances.find(item=>item.id===instance.id);
    if(generation!==sessionGeneration||!connected||navigation!==navigationGeneration||route!=='runtime-instances'||!current||
      runtimeGenerationIdentity(current)!==identity||value.instanceId!==instance.id||!Array.isArray(value.generations)||!Array.isArray(value.operations))return;
    runtimeUpgradeLists.set(instance.id,{identity,value});runtimeUpgradeErrors.delete(instance.id);render();
  }catch(error){
    const current=runtimeOverview?.instances.find(item=>item.id===instance.id);
    if(generation===sessionGeneration&&connected&&navigation===navigationGeneration&&route==='runtime-instances'&&current&&runtimeGenerationIdentity(current)===identity){
      runtimeUpgradeErrors.set(instance.id,error instanceof Error?error.message:'Generation history is unavailable');render();
    }
  }finally{runtimeUpgradeRequests.delete(requestIdentity);}
}
async function loadRuntimeBackups(instance:ManagedRuntimeInstance,actionIdentity:string,generation:number,navigation:number){
  const value=await api(`/platform-api/runtime-instances/${encodeURIComponent(instance.id)}/backups`) as RuntimeRecoveryList;
  if(generation!==sessionGeneration||!connected||navigation!==navigationGeneration||route!=='runtime-instances'||
    !runtimeOverview?.instances.some(current=>current.id===instance.id&&current.currentAttempt===instance.currentAttempt&&current.artifactDigest===instance.artifactDigest))return;
  runtimeRecoveryLists.set(actionIdentity,value);runtimeRecoveryErrors.delete(actionIdentity);render();
}
document.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const loadProduct=target.closest<HTMLElement>('[data-product-load]');
  if(loadProduct){const identity=(app.querySelector<HTMLSelectElement>('#saved-product-version')?.value??'');const split=identity.lastIndexOf('@');if(split<1){actionError='Choose an exact saved product version first.';render();return;}
    const id=identity.slice(0,split),version=identity.slice(split+1),session=sessionGeneration,generation=productEditorGeneration,sequence=++productEditorRequestSequence,navigation=navigationGeneration;
    productEditorBusy=true;selectedSavedProduct=identity;actionError='';render();void(async()=>{try{const result=await api(`/platform-api/products/${encodeURIComponent(id)}/${encodeURIComponent(version)}`);if(session!==sessionGeneration||generation!==productEditorGeneration||sequence!==productEditorRequestSequence||navigation!==navigationGeneration||!connected||route!=='products')return;setProductEditorText(`${JSON.stringify(result.product,null,2)}\n`);productEditorBusy=false;selectedSavedProduct=identity;savedFamilyDerivation=result.familyDerivation??null;render();}catch(error){if(session===sessionGeneration&&generation===productEditorGeneration&&sequence===productEditorRequestSequence){productEditorBusy=false;actionError=error instanceof Error?error.message:'Saved definition could not be loaded';render();}}})();return;}
  const previewProduct=target.closest<HTMLElement>('[data-product-preview]');
  if(previewProduct){const generation=productEditorGeneration,session=sessionGeneration,navigation=navigationGeneration,sequence=++productEditorRequestSequence;let value:Record<string,any>;
    try{value=parseProductEditorText();}catch(error){productEditorDiagnostics=[error instanceof Error?error.message:'Product JSON is invalid.'];render();return;}
    productEditorBusy=true;productEditorDiagnostics=[];actionError='';render();void(async()=>{try{const result=await api('/platform-api/products/preview','POST',{product:value});if(generation!==productEditorGeneration||session!==sessionGeneration||navigation!==navigationGeneration||sequence!==productEditorRequestSequence||!connected||route!=='products')return;productPreview=result;productPreviewGeneration=generation;productEditorDiagnostics=Array.isArray(result.diagnostics)?result.diagnostics:[];productEditorBusy=false;render();}catch(error){if(generation===productEditorGeneration&&session===sessionGeneration&&navigation===navigationGeneration&&sequence===productEditorRequestSequence){productEditorBusy=false;productEditorDiagnostics=[error instanceof Error?error.message:'Preview failed'];render();}}})();return;}
  const saveProduct=target.closest<HTMLElement>('[data-product-save]');
  if(saveProduct){if(!connected||route!=='products'||!productPreview?.valid||productPreviewGeneration!==productEditorGeneration){actionError='Preview the current exact definition before saving.';render();return;}
    const generation=productEditorGeneration,session=sessionGeneration,navigation=navigationGeneration,product=JSON.parse(JSON.stringify(productPreview.product));
    const confirmation=saveProduct.closest<HTMLElement>('.result-card')?.querySelector<HTMLInputElement>('[data-product-save-confirm]');
    if(!confirmation?.checked){actionError=`Confirm saving the exact immutable version ${product.id}@${product.version} first.`;render();return;}
    confirmation.checked=false;
    const sequence=++productEditorRequestSequence;
    const derivation=familyClaimGeneration===generation?familyClaimIntent:undefined;
    productEditorBusy=true;actionError='';render();void(async()=>{try{const saved=await api('/platform-api/products','POST',{confirm:true,product,...(derivation?{derivation}:{})});if(session!==sessionGeneration||!connected)return;const current=generation===productEditorGeneration&&sequence===productEditorRequestSequence&&navigation===navigationGeneration;if(current){productEditorBusy=false;actionError=`Saved ${product.id}@${product.version}. Build it from the Builds page when ready.`;productPreview=null;productPreviewGeneration=-1;savedFamilyDerivation=saved.familyDerivation??null;familyClaimIntent=null;familyClaimGeneration=-1;}await loadOverview();if(session===sessionGeneration&&connected&&current)render();}catch(error){if(session===sessionGeneration&&connected&&generation===productEditorGeneration&&sequence===productEditorRequestSequence&&navigation===navigationGeneration){productEditorBusy=false;actionError=error instanceof Error?error.message:'Product version could not be saved';render();}}})();return;}
  const exportProduct=target.closest<HTMLElement>('[data-product-export]');
  if(exportProduct){if(!productPreview?.valid||productPreviewGeneration!==productEditorGeneration)return;const blob=new Blob([`${JSON.stringify(productPreview.product,null,2)}\n`],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=`${productPreview.product.id}.product.json`;link.click();URL.revokeObjectURL(url);return;}
  const button = target.closest<HTMLElement>('[data-route]');
  if (button && connected) { activateRoute(button.dataset.route!,true);return; }
  if(target.closest('[data-retry-artifact-registry]')){if(artifactRegistryState!=='loading')void loadArtifactRegistry();return;}
  if(target.closest('[data-retry-runtime]')){const generation=sessionGeneration;runtimeLoadError='';render();void loadRuntimeOverview().catch(error=>{if(generation===sessionGeneration&&connected){runtimeLoadError=error instanceof Error?error.message:'Runtime state unavailable';render();}});return;}
  const loadBackups=target.closest<HTMLElement>('[data-runtime-backups-load]');
  if(loadBackups)void(async()=>{const id=loadBackups.dataset.runtimeBackupsLoad!,instance=runtimeOverview?.instances.find(item=>item.id===id);
    if(!instance||!runtimeHasStoppedProof(instance)){actionError='Private backups require verified stop and cleanup for the current attempt.';render();return;}
    const key=`${instance.id}:${instance.currentAttempt}:${instance.artifactDigest}`,pendingKey=`LIST:${key}`;if(runtimePending.has(pendingKey))return;
    const generation=sessionGeneration,navigation=navigationGeneration,stillCurrent=()=>generation===sessionGeneration&&connected&&navigation===navigationGeneration&&
      runtimeOverview?.instances.some(current=>current.id===id&&current.currentAttempt===instance.currentAttempt&&current.artifactDigest===instance.artifactDigest);
    runtimePending.add(pendingKey);runtimeRecoveryErrors.delete(key);render();
    try{await loadRuntimeBackups(instance,key,generation,navigation);}catch(error){if(stillCurrent()){runtimeRecoveryErrors.set(key,error instanceof Error?error.message:'Private backups are unavailable');render();}}
    finally{if(generation===sessionGeneration){runtimePending.delete(pendingKey);render();}}
  })();
  const createBackup=target.closest<HTMLElement>('[data-runtime-backup-create]');
  if(createBackup)void(async()=>{const id=createBackup.dataset.runtimeBackupCreate!,instance=runtimeOverview?.instances.find(item=>item.id===id);
    if(!instance||!runtimeHasStoppedProof(instance)){actionError='Private backups require verified stop and cleanup for the current attempt.';render();return;}
    const identity=`${instance.id}:${instance.currentAttempt}:${instance.artifactDigest}`,pendingKey=`BACKUP:${identity}`,requestIntent=pendingKey;
    if(runtimePending.has(pendingKey))return;
    const confirmation=createBackup.closest('article')?.querySelector<HTMLInputElement>('[data-runtime-backup-confirm]');
    if(!confirmation?.checked){actionError='Confirm creation of a private backup for this exact stopped runtime first.';render();return;}
    const generation=sessionGeneration,navigation=navigationGeneration,requestKey=runtimeRequestKey(requestIntent),stillCurrent=()=>generation===sessionGeneration&&connected&&navigation===navigationGeneration&&
      runtimeOverview?.instances.some(current=>current.id===id&&current.currentAttempt===instance.currentAttempt&&current.artifactDigest===instance.artifactDigest);
    confirmation.checked=false;runtimePending.add(pendingKey);runtimeRecoveryErrors.delete(identity);actionError='';render();
    try{const result=await api(`/platform-api/runtime-instances/${encodeURIComponent(id)}/backups`,'POST',{confirm:true,requestKey});
      runtimeRequestKeys.delete(requestIntent);if(!stillCurrent())return;
      actionError=`Backup operation ${result.state??'recorded'}: ${result.errorCode??'no issue reported'}.`;await loadRuntimeBackups(instance,identity,generation,navigation);
    }catch(error){if(stillCurrent()){runtimeRecoveryErrors.set(identity,error instanceof Error?error.message:'Private backup failed');render();}}
    finally{if(generation===sessionGeneration){runtimePending.delete(pendingKey);render();}}
  })();
  const verifyBackup=target.closest<HTMLElement>('[data-runtime-backup-verify]');
  if(verifyBackup)void(async()=>{const digest=verifyBackup.dataset.runtimeBackupVerify!,id=verifyBackup.dataset.runtimeInstance!,instance=runtimeOverview?.instances.find(item=>item.id===id);
    if(!instance||!runtimeHasStoppedProof(instance)||!runtimeRecoveryLists.get(`${id}:${instance.currentAttempt}:${instance.artifactDigest}`)?.backups.some(item=>item.digest===digest))return;
    const identity=`${id}:${instance.currentAttempt}:${instance.artifactDigest}`,pendingKey=`VERIFY:${identity}:${digest}`;if(runtimePending.has(pendingKey))return;
    const generation=sessionGeneration,navigation=navigationGeneration,stillCurrent=()=>generation===sessionGeneration&&connected&&navigation===navigationGeneration&&
      runtimeOverview?.instances.some(current=>current.id===id&&current.currentAttempt===instance.currentAttempt&&current.artifactDigest===instance.artifactDigest);
    runtimePending.add(pendingKey);runtimeRecoveryErrors.delete(identity);render();
    try{const result=await api(`/platform-api/runtime-backups/${encodeURIComponent(digest)}`) as RuntimeBackupVerification;
      if(generation!==sessionGeneration||!connected||navigation!==navigationGeneration||!runtimeOverview?.instances.some(current=>current.id===id&&current.currentAttempt===instance.currentAttempt&&current.artifactDigest===instance.artifactDigest))return;
      if(result.verified!==true||result.digest!==digest||result.instanceId!==id)throw new Error('The verified backup identity did not match this runtime.');
      runtimeBackupVerifications.set(digest,result);render();
    }catch(error){if(stillCurrent()){runtimeRecoveryErrors.set(identity,error instanceof Error?error.message:'Backup verification failed');render();}}
    finally{if(generation===sessionGeneration){runtimePending.delete(pendingKey);render();}}
  })();
  const restoreBackup=target.closest<HTMLElement>('[data-runtime-restore]');
  if(restoreBackup)void(async()=>{const id=restoreBackup.dataset.runtimeRestore!,digest=restoreBackup.dataset.backupDigest!,instance=runtimeOverview?.instances.find(item=>item.id===id);
    if(!instance||!runtimeHasStoppedProof(instance)||runtimeBackupVerifications.get(digest)?.verified!==true){actionError='Verify the selected backup and confirm the stopped runtime identity before restoring.';render();return;}
    const identity=`${id}:${instance.currentAttempt}:${instance.artifactDigest}`,pendingKey=`RESTORE:${identity}:${digest}`,requestIntent=pendingKey;if(runtimePending.has(pendingKey))return;
    const confirmation=restoreBackup.closest('article')?.querySelector<HTMLInputElement>('[data-runtime-restore-confirm]');
    if(!confirmation?.checked){actionError='Confirm restoring this verified backup into the absent data location first.';render();return;}
    const generation=sessionGeneration,navigation=navigationGeneration,requestKey=runtimeRequestKey(requestIntent),stillCurrent=()=>generation===sessionGeneration&&connected&&navigation===navigationGeneration&&
      runtimeOverview?.instances.some(current=>current.id===id&&current.currentAttempt===instance.currentAttempt&&current.artifactDigest===instance.artifactDigest);
    confirmation.checked=false;runtimePending.add(pendingKey);runtimeRecoveryErrors.delete(identity);actionError='';render();
    try{const result=await api(`/platform-api/runtime-instances/${encodeURIComponent(id)}/restore`,'POST',{confirm:true,backupDigest:digest,requestKey});
      runtimeRequestKeys.delete(requestIntent);if(!stillCurrent())return;
      actionError=`Restore operation ${result.state??'recorded'}: ${result.errorCode??'no issue reported'}.`;
      await loadRuntimeBackups(instance,identity,generation,navigation);
    }catch(error){if(stillCurrent()){runtimeRecoveryErrors.set(identity,error instanceof Error?error.message:'Private restore failed');render();}}
    finally{if(generation===sessionGeneration){runtimePending.delete(pendingKey);render();}}
  })();
  const runtimeUpgrade=target.closest<HTMLElement>('[data-runtime-upgrade]');
  if(runtimeUpgrade)void(async()=>{
    const id=runtimeUpgrade.dataset.runtimeUpgrade!,backupDigest=runtimeUpgrade.dataset.backupDigest!,instance=runtimeOverview?.instances.find(item=>item.id===id);
    const evidenceInstance=instance?runtimeEvidenceInstance(instance):undefined;
    const historyEntry=runtimeUpgradeLists.get(id),history=instance&&historyEntry?.identity===runtimeGenerationIdentity(instance)?historyEntry.value:undefined;
    const generation=evidenceInstance?.activeGenerationId?history?.generations.find(item=>item.id===evidenceInstance.activeGenerationId):undefined;
    const backups=runtimeRecoveryLists.get(`${id}:${instance?.currentAttempt}:${instance?.artifactDigest}`)?.backups??[];
    const backup=backups.find(item=>item.digest===backupDigest),verification=runtimeBackupVerifications.get(backupDigest);
    const card=runtimeUpgrade.closest<HTMLElement>('article'),targetSelect=card?.querySelector<HTMLSelectElement>('[data-runtime-upgrade-target]');
    const selectedValue=targetSelect?.value??'',separator=selectedValue.indexOf('|'),version=separator>0?selectedValue.slice(0,separator):'',artifactDigest=separator>0?selectedValue.slice(separator+1):'';
    const release=runtimeReleases.find(item=>item.productId===instance?.productId&&item.version===version&&item.artifactDigest===artifactDigest);
    if(!instance||instance.state!=='STOPPED'||!runtimeHasStoppedProof(instance)||!history||!generation||generation.version!==instance.version||generation.artifactDigest!==instance.artifactDigest||
      !backup||backup.instanceId!==id||backup.generationId!==generation.id||backup.attempt!==instance.currentAttempt||backup.artifactDigest!==instance.artifactDigest||
      !verification?.verified||verification.digest!==backupDigest||verification.instanceId!==id||!release||compareRuntimeVersions(release.version,instance.version)<=0){
      actionError='Upgrade requires the exact current stopped generation, its matching backup, a successful verification, and a newer promoted release.';render();return;
    }
    const intent=createRuntimeUpgradeIntent(instance,generation,backup,release);
    if(runtimePending.has(intent.requestIdentity)||runtimePending.has(intent.instanceLockKey))return;
    const confirmation=card?.querySelector<HTMLInputElement>('[data-runtime-upgrade-confirm]');
    if(!confirmation?.checked){actionError=`Confirm upgrade of ${instance.productId}@${instance.version} from generation ${generation.generation}, using verified backup ${backupDigest}, to ${release.version} (${release.artifactDigest}).`;render();return;}
    const pendingKey=intent.requestIdentity,session=sessionGeneration,navigation=navigationGeneration,requestKey=runtimeRequestKey(intent.requestIdentity);
    const stillCurrent=()=>session===sessionGeneration&&connected&&navigation===navigationGeneration&&route==='runtime-instances'&&
      runtimeOverview?.instances.some(current=>current.id===id&&current.state==='STOPPED'&&current.currentAttempt===instance.currentAttempt&&
        runtimeEvidenceInstance(current).activeGenerationId===generation.id&&current.artifactDigest===instance.artifactDigest);
    confirmation.checked=false;runtimePending.add(pendingKey);runtimePending.add(intent.instanceLockKey);actionError='';render();
    try{
      const result=await api(`/platform-api/runtime-instances/${encodeURIComponent(id)}/upgrades`,'POST',{confirm:true,targetVersion:release.version,
        targetArtifactDigest:release.artifactDigest,sourceBackupDigest:backupDigest,requestKey});
      if(session!==sessionGeneration||!connected)return;
      runtimeRequestKeys.delete(intent.requestIdentity);
      if(stillCurrent())actionError=`Upgrade operation ${result.state??'recorded'}: ${result.physicalState??'physical state unavailable'}${result.errorCode?` · ${result.errorCode}`:''}.`;
      runtimeUpgradeLists.delete(id);runtimeUpgradeErrors.delete(id);
      if(navigation===navigationGeneration&&route==='runtime-instances')await loadRuntimeOverview();
    }catch(error){if(stillCurrent()){actionError=error instanceof Error?error.message:'Local runtime upgrade did not return a result';render();}}
    finally{if(session===sessionGeneration){runtimePending.delete(pendingKey);runtimePending.delete(intent.instanceLockKey);render();}}
  })();
  const inspectArtifact=target.closest<HTMLElement>('[data-inspect-artifact]');
  if(inspectArtifact){const digest=inspectArtifact.dataset.inspectArtifact!,inspection=++artifactInspectionGeneration,session=sessionGeneration,navigation=navigationGeneration;
    artifactInspectionLoading=true;artifactInspectionDigest=digest;selectedArtifact=null;actionError='';render();void(async()=>{try{const value=await api(`/platform-api/artifacts/${encodeURIComponent(digest)}`);
      if(inspection!==artifactInspectionGeneration||session!==sessionGeneration||!connected||navigation!==navigationGeneration||route!=='artifacts')return;
      if(value?.digest!==digest){artifactInspectionLoading=false;artifactInspectionDigest='';actionError='The verified artifact response did not match the requested digest.';render();return;}
      artifactInspectionLoading=false;artifactInspectionDigest='';selectedArtifact=value;render();
    }catch(error){if(inspection===artifactInspectionGeneration&&session===sessionGeneration&&connected&&navigation===navigationGeneration&&route==='artifacts'){
      artifactInspectionLoading=false;artifactInspectionDigest='';actionError=error instanceof Error?error.message:'Artifact verification failed';render();}}
  })();return;}
  if(target.closest('[data-close-artifact]')){artifactInspectionGeneration++;artifactInspectionLoading=false;artifactInspectionDigest='';selectedArtifact=null;actionError='';render();return;}
  const registerArtifact=target.closest<HTMLElement>('[data-register-artifact]');
  if(registerArtifact)void (async()=>{const generation=sessionGeneration;const confirmation=registerArtifact.closest('article')?.querySelector<HTMLInputElement>('[data-register-confirm]');if(!confirmation?.checked){actionError='Confirm registration of this exact successful build first.';render();return;}try{confirmation.checked=false;await api('/platform-api/artifacts/register','POST',{confirm:true,buildId:registerArtifact.dataset.registerArtifact});if(generation!==sessionGeneration)return;actionError='The verified snapshot is registered locally.';await loadArtifactRegistry();await loadOverview();}catch(error){if(generation===sessionGeneration&&connected){actionError=error instanceof Error?error.message:'Artifact registration failed';render();}}})();
  const promoteArtifact=target.closest<HTMLElement>('[data-promote-artifact]');
  if(promoteArtifact)void (async()=>{const generation=sessionGeneration;const confirmation=promoteArtifact.closest('article')?.querySelector<HTMLInputElement>('[data-promote-confirm]');if(!confirmation?.checked){actionError='Confirm promotion of this exact product version first.';render();return;}try{confirmation.checked=false;await api('/platform-api/releases','POST',{confirm:true,productId:promoteArtifact.dataset.product,version:promoteArtifact.dataset.version,artifactDigest:promoteArtifact.dataset.promoteArtifact});if(generation!==sessionGeneration)return;actionError='The immutable local release is promoted.';await loadArtifactRegistry();}catch(error){if(generation===sessionGeneration&&connected){actionError=error instanceof Error?error.message:'Release promotion failed';render();}}})();
  const runtimeStart=target.closest<HTMLElement>('[data-runtime-start]');
  if(runtimeStart)void (async()=>{
    const productId=runtimeStart.dataset.product!,version=runtimeStart.dataset.version!,release=runtimeReleases.find(item=>item.productId===productId&&item.version===version),pendingKey=`START:${productId}@${version}:${release?.artifactDigest??''}`,generation=sessionGeneration,navigation=navigationGeneration,requestKey=runtimeRequestKey(pendingKey);
    if(runtimePending.has(pendingKey))return;
    const confirmation=runtimeStart.closest('article')?.querySelector<HTMLInputElement>('[data-runtime-start-confirm]');
    if(!confirmation?.checked){actionError='Confirm this exact promoted release before starting it.';render();return;}
    confirmation.checked=false;runtimePending.add(pendingKey);actionError='';render();
    try{const result=await api('/platform-api/runtime-instances','POST',{confirm:true,productId,version,requestKey});
      runtimeRequestKeys.delete(pendingKey);
      if(generation!==sessionGeneration||!connected)return;if(navigation===navigationGeneration)actionError=runtimeResultMessage('start',result);await loadRuntimeOverview();
    }catch(error){if(generation===sessionGeneration&&connected&&navigation===navigationGeneration){actionError=error instanceof Error?error.message:'Local runtime start failed';render();}}
    finally{if(generation===sessionGeneration){runtimePending.delete(pendingKey);render();}}
  })();
  const runtimeStop=target.closest<HTMLElement>('[data-runtime-stop]');
  if(runtimeStop)void (async()=>{
    const instanceId=runtimeStop.dataset.runtimeStop!,attempt=runtimeStop.dataset.attempt!,digest=runtimeStop.dataset.artifactDigest!,pendingKey=`STOP:${instanceId}:${attempt}:${digest}`,generation=sessionGeneration,navigation=navigationGeneration,requestKey=runtimeRequestKey(pendingKey);
    if(runtimePending.has(pendingKey))return;
    const confirmation=runtimeStop.closest('article')?.querySelector<HTMLInputElement>('[data-runtime-action-confirm]');
    if(!confirmation?.checked){actionError='Confirm stopping this exact local runtime first.';render();return;}
    confirmation.checked=false;runtimePending.add(pendingKey);actionError='';render();
    try{const result=await api(`/platform-api/runtime-instances/${encodeURIComponent(instanceId)}/stop`,'POST',{confirm:true,requestKey});
      runtimeRequestKeys.delete(pendingKey);
      if(generation!==sessionGeneration||!connected)return;if(navigation===navigationGeneration)actionError=runtimeResultMessage('stop',result);await loadRuntimeOverview();
    }catch(error){if(generation===sessionGeneration&&connected&&navigation===navigationGeneration){actionError=error instanceof Error?error.message:'Local runtime stop failed';render();}}
    finally{if(generation===sessionGeneration){runtimePending.delete(pendingKey);render();}}
  })();
  const androidClient=target.closest<HTMLElement>('[data-runtime-android-client]');
  if(androidClient)void (async()=>{
    const instanceId=androidClient.dataset.runtimeAndroidClient!,generationId=androidClient.dataset.generation!,artifactDigest=androidClient.dataset.artifactDigest!;
    const generation=sessionGeneration,navigation=navigationGeneration,instance=runtimeOverview?.instances.find(item=>item.id===instanceId);
    const inspected=instance&&runtimeEvidenceInstance(instance);
    const pendingKey=`ANDROID_CLIENT:${instanceId}:${generationId}:${instance?.currentAttempt??''}:${artifactDigest}`;
    if(!instance||!inspected||route!=='runtime-instances'||runtimePending.has(pendingKey)||!connected||
      inspected.activeGenerationId!==generationId||inspected.artifactDigest!==artifactDigest||
      !runtimeDetailMatches(selectedRuntime,instance)||selectedRuntime?.activeGenerationId!==generationId||
      selectedRuntime.nativeApiProfile!=='local-native-forwarded-v1'||!['RUNNING','STOPPED'].includes(instance.state)){
      actionError='Inspect the exact current managed generation with the fixed native profile before packaging its Android client.';render();return;
    }
    const confirmation=androidClient.closest('article')?.querySelector<HTMLInputElement>('[data-runtime-android-client-confirm]');
    if(!confirmation?.checked){actionError='Confirm packaging this exact managed runtime generation first.';render();return;}
    confirmation.checked=false;runtimePending.add(pendingKey);actionError='';render();
    try{
      const value=await api(`/platform-api/runtime-instances/${encodeURIComponent(instanceId)}/android-client`,'POST',{confirm:true});
      if(generation!==sessionGeneration||!connected||navigation!==navigationGeneration||route!=='runtime-instances')return;
      const current=runtimeOverview?.instances.find(item=>item.id===instanceId),currentDetail=current&&runtimeDetailMatches(selectedRuntime,current)?selectedRuntime:null;
      if(!current||runtimeEvidenceInstance(current).activeGenerationId!==generationId||current.artifactDigest!==artifactDigest||
        currentDetail?.activeGenerationId!==generationId||currentDetail.nativeApiProfile!=='local-native-forwarded-v1')return;
      if(value.instanceId!==instanceId||value.generationId!==generationId||value.artifactDigest!==artifactDigest||
        typeof value.clientReference!=='string'||!/^managed-mobile-[a-f0-9]{20}$/.test(value.clientReference)||typeof value.outputDir!=='string'||
        value.productVersion!==current.version){actionError='The server returned a client package for a different managed generation.';render();return;}
      runtimeAndroidClients.set(`${instanceId}:${generationId}:${instance.currentAttempt}:${artifactDigest}`,{
        clientReference:value.clientReference,outputDir:value.outputDir,generationId,artifactDigest,productVersion:value.productVersion});
      actionError='The Android client was derived from the captured promoted artifact. Build and install it with the fixed local toolchain commands below.';render();
    }catch(error){if(generation===sessionGeneration&&connected&&navigation===navigationGeneration&&route==='runtime-instances'){
      actionError=error instanceof Error?error.message:'Android client packaging failed';render();}}
    finally{runtimePending.delete(pendingKey);if(generation===sessionGeneration&&connected&&navigation===navigationGeneration)render();}
  })();
  const runtimeRestart=target.closest<HTMLElement>('[data-runtime-restart]');
  if(runtimeRestart)void (async()=>{
    const instanceId=runtimeRestart.dataset.runtimeRestart!,attempt=runtimeRestart.dataset.attempt!,digest=runtimeRestart.dataset.artifactDigest!,pendingKey=`RESTART:${instanceId}:${attempt}:${digest}`,generation=sessionGeneration,navigation=navigationGeneration,requestKey=runtimeRequestKey(pendingKey);
    if(runtimePending.has(pendingKey))return;
    const confirmation=runtimeRestart.closest('article')?.querySelector<HTMLInputElement>('[data-runtime-action-confirm]');
    if(!confirmation?.checked){actionError='Confirm restarting this exact stopped runtime first.';render();return;}
    confirmation.checked=false;runtimePending.add(pendingKey);actionError='';render();
    try{const result=await api(`/platform-api/runtime-instances/${encodeURIComponent(instanceId)}/restart`,'POST',{confirm:true,requestKey});
      runtimeRequestKeys.delete(pendingKey);
      if(generation!==sessionGeneration||!connected)return;if(navigation===navigationGeneration)actionError=runtimeResultMessage('restart',result);await loadRuntimeOverview();
    }catch(error){if(generation===sessionGeneration&&connected&&navigation===navigationGeneration){actionError=error instanceof Error?error.message:'Local runtime restart failed';render();}}
    finally{if(generation===sessionGeneration){runtimePending.delete(pendingKey);render();}}
  })();
  const runtimeDetails=target.closest<HTMLElement>('[data-runtime-detail]');
  if(runtimeDetails)void (async()=>{const generation=sessionGeneration,navigation=navigationGeneration,id=runtimeDetails.dataset.runtimeDetail!,sequence=++runtimeDetailSequence;
    const requested=runtimeOverview?.instances.find(instance=>instance.id===id);if(!requested)return;const attempt=requested.currentAttempt,digest=requested.artifactDigest;
    const stillSelected=()=>generation===sessionGeneration&&navigation===navigationGeneration&&route==='runtime-instances'&&sequence===runtimeDetailSequence&&runtimeOverview?.instances.some(instance=>instance.id===id&&instance.currentAttempt===attempt&&instance.artifactDigest===digest);
    try{const value=await api(`/platform-api/runtime-instances/${encodeURIComponent(id)}`);if(!stillSelected()||!runtimeDetailMatches(value as ManagedRuntimeInstance,requested))return;selectedRuntime=value as ManagedRuntimeInstance;actionError='';render();
  }catch(error){if(stillSelected()){actionError=error instanceof Error?error.message:'Runtime events are unavailable';render();}}})();
  const requestBuild = target.closest<HTMLElement>('[data-request-build]');
  if (requestBuild) void (async()=>{const productId=requestBuild.dataset.requestBuild!,version=requestBuild.dataset.version!;const confirmation=requestBuild.closest('article')?.querySelector<HTMLInputElement>('[data-build-confirm]');if(!confirmation?.checked){actionError='Confirm the local build request first.';render();return;}try{confirmation.checked=false;await api('/platform-api/builds','POST',{confirm:true,productId,version,requestKey:crypto.randomUUID()});actionError='Build request admitted.';await loadOverview();}catch(error){if(connected){actionError=error instanceof Error?error.message:'Could not request build';render();}}})();
  const cancel = target.closest<HTMLElement>('[data-cancel]');
  if (cancel) void (async()=>{try{await api(`/platform-api/builds/${encodeURIComponent(cancel.dataset.cancel!)}/cancel`,'POST',{confirm:true});actionError='Cancellation request recorded.';await loadOverview();}catch(error){if(connected){actionError=error instanceof Error?error.message:'Could not cancel build';render();}}})();
  const result = target.closest<HTMLElement>('[data-result]');
  if (result) void (async()=>{try{const value=await api(`/platform-api/builds/${encodeURIComponent(result.dataset.result!)}/result`);buildDetails.set(result.dataset.result!,`VERIFIED LOCAL EXPORT\nSnapshot identity: ${value.snapshot.id}\nSnapshot digest: ${value.snapshot.digest}\nRelease digest: ${value.snapshot.releaseDigest}`);render();}catch(error){if(connected){actionError=error instanceof Error?error.message:'Export verification failed';render();}}})();
  const logButton = target.closest<HTMLElement>('[data-log]');
  if (logButton) void (async()=>{try{const value=await api(`/platform-api/builds/${encodeURIComponent(logButton.dataset.log!)}/log`);buildDetails.set(logButton.dataset.log!,value.log||'(No build output was recorded.)');render();}catch(error){if(connected){actionError=error instanceof Error?error.message:'Build log unavailable';render();}}})();
  if (target.closest('[data-logout]')) void (async () => {
    sessionGeneration++;navigationGeneration++;runtimeOverviewSequence++;runtimeDetailSequence++;
    artifactInspectionGeneration++;artifactInspectionLoading=false;artifactInspectionDigest='';disconnecting=true;connected=false;data=null;catalogue=null;composed=null;clearProductEditor();productCatalogueSignature='';artifactRegistry=null;artifactRegistryState='idle';artifactRegistryRequest=undefined;artifactLoadError='';selectedArtifact=null;runtimeOverview=null;runtimeReleases=[];runtimeLoadError='';selectedRuntime=null;runtimePending.clear();runtimeRequestKeys.clear();clearRuntimeRecoveryState();buildDetails.clear();if(refreshTimer){clearInterval(refreshTimer);refreshTimer=undefined;}render();
    try {
      const response = await fetch('/platform-api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('Disconnect request failed');
    } catch (error) { loginError = error instanceof Error ? error.message : 'Disconnect request failed'; }
    disconnecting=false;connected = false; data = null; catalogue=null;composed=null;clearProductEditor();productCatalogueSignature='';artifactRegistry=null;artifactRegistryState='idle';artifactRegistryRequest=undefined;artifactLoadError='';selectedArtifact=null;runtimeOverview=null;runtimeReleases=[];runtimeLoadError='';selectedRuntime=null;runtimePending.clear();runtimeRequestKeys.clear();clearRuntimeRecoveryState();buildDetails.clear();if(refreshTimer){clearInterval(refreshTimer);refreshTimer=undefined;}render();
  })();
});
function captureComposeDraft(form:HTMLFormElement) {
  composeDraft.id=(form.elements.namedItem('id') as HTMLInputElement).value;
  composeDraft.title=(form.elements.namedItem('title') as HTMLInputElement).value;
  composeDraft.version=(form.elements.namedItem('version') as HTMLInputElement).value;
  composeDraft.layout=(form.elements.namedItem('layout') as HTMLSelectElement).value;
  composeDraft.selected=[...form.querySelectorAll<HTMLInputElement>('input[name="selected"]:checked')].map(input=>input.value);
}
function captureFamilyDraft(form:HTMLFormElement,target:HTMLElement){
  const values=new FormData(form);
  const nextFamilyId=String(values.get('familyId')??'');
  const changingFamily=nextFamilyId!==selectedFamilyId;
  selectedFamilyId=nextFamilyId;
  const sourceFamily=(catalogue?.families??[]).find(item=>item.id===selectedFamilyId);
  selectedFamilyFeatures=changingFamily?[...(sourceFamily?.defaultFeatureIds??[])]:[...form.querySelectorAll<HTMLInputElement>('input[name="familyFeature"]:checked')].map(item=>item.value);
  familyIdentity.id=String(values.get('id')??'');familyIdentity.title=String(values.get('title')??'');
  familyIdentity.version=String(values.get('version')??'');familyIdentity.description=String(values.get('description')??'');
  familyIdentity.layout=values.get('layout')==='top'?'top':'sidebar';
  familyDeriveBusy=false;actionError='';invalidateProductEditor();
  const name=(target as HTMLInputElement).name;
  const start=target instanceof HTMLInputElement?target.selectionStart:null,end=target instanceof HTMLInputElement?target.selectionEnd:null;
  render();const replacement=app.querySelector<HTMLInputElement|HTMLSelectElement>(`#family-derive-form [name="${CSS.escape(name)}"]`);
  replacement?.focus();if(replacement instanceof HTMLInputElement&&start!==null&&end!==null)replacement.setSelectionRange(start,end);
}
document.addEventListener('input',event=>{const target=event.target as HTMLElement;const familyForm=target.closest<HTMLFormElement>('#family-derive-form');if(familyForm){captureFamilyDraft(familyForm,target);return;}const form=target.closest<HTMLFormElement>('#compose-form');if(form)captureComposeDraft(form);if(target instanceof HTMLTextAreaElement&&target.matches('[data-product-json]'))setProductEditorText(target.value,target);if(target instanceof HTMLTextAreaElement&&target.dataset.productArray)patchProductEditorArray(target.dataset.productArray as 'modules'|'bindings',target.value,target);});
document.addEventListener('change',event=>{const target=event.target as HTMLElement;if(target instanceof HTMLSelectElement&&target.dataset.runtimeUpgradeTarget){runtimeUpgradeTargets.set(target.dataset.runtimeUpgradeTarget,target.value);const card=target.closest<HTMLElement>('article');const confirmation=card?.querySelector<HTMLInputElement>('[data-runtime-upgrade-confirm]');if(confirmation)confirmation.checked=false;actionError='';render();return;}const form=target.closest<HTMLFormElement>('#compose-form');if(form)captureComposeDraft(form);if(target instanceof HTMLSelectElement&&target.id==='saved-product-version'){invalidateProductEditor();selectedSavedProduct=target.value;render();return;}if((target instanceof HTMLInputElement||target instanceof HTMLSelectElement)&&target.dataset.productField)patchProductEditorField(target.dataset.productField,target.value,target);});
document.addEventListener('change',event=>{const target=event.target as HTMLElement;const form=target.closest<HTMLFormElement>('#family-derive-form');if(form)captureFamilyDraft(form,target);});
document.addEventListener('change',event=>{const target=event.target as HTMLElement;if(!(target instanceof HTMLInputElement)||!target.matches('[data-product-import]'))return;const file=target.files?.[0];if(!file)return;target.value='';invalidateProductEditor();const session=sessionGeneration,generation=productEditorGeneration,sequence=++productEditorRequestSequence;if(file.size>65536){productEditorDiagnostics=['Product JSON must be at most 64 KiB.'];render();return;}void(async()=>{try{const source=await file.text();if(session!==sessionGeneration||generation!==productEditorGeneration||sequence!==productEditorRequestSequence||!connected)return;productEditorBusy=false;setProductEditorText(source);}catch{if(session===sessionGeneration&&generation===productEditorGeneration&&sequence===productEditorRequestSequence){productEditorDiagnostics=['The selected product file could not be read.'];render();}}})();});
document.addEventListener('submit', event => {
  const form = event.target as HTMLElement;
  if(form.matches('#family-derive-form')){
    event.preventDefault();const familyForm=form as HTMLFormElement;const values=new FormData(familyForm);
    const request={familyId:String(values.get('familyId')??''),selection:[...familyForm.querySelectorAll<HTMLInputElement>('input[name="familyFeature"]:checked')].map(input=>input.value),
      identity:{id:String(values.get('id')??''),title:String(values.get('title')??''),version:String(values.get('version')??''),description:String(values.get('description')??''),layout:values.get('layout')==='top'?'top':'sidebar'}};
    selectedFamilyId=request.familyId;selectedFamilyFeatures=[...request.selection];Object.assign(familyIdentity,request.identity);invalidateProductEditor();
    const generation=productEditorGeneration,session=sessionGeneration,navigation=navigationGeneration,sequence=++productEditorRequestSequence;
    familyDeriveBusy=true;familyDerivation=null;actionError='';render();
    void(async()=>{try{const result=await api('/platform-api/products/derive-family','POST',request);
      if(generation!==productEditorGeneration||session!==sessionGeneration||navigation!==navigationGeneration||sequence!==productEditorRequestSequence||!connected||route!=='products')return;
      setProductEditorText(`${JSON.stringify(result.product,null,2)}\n`);productEditorBusy=false;familyDerivation={...result.familyDerivation,technicalExplanations:result.technicalExplanations};familyClaimIntent=request;familyClaimGeneration=productEditorGeneration;familyDeriveBusy=false;actionError='Family definition derived. Review the exact JSON and preview it before saving.';render();
    }catch(error){if(session===sessionGeneration&&navigation===navigationGeneration&&sequence===productEditorRequestSequence){familyDeriveBusy=false;actionError=error instanceof Error?error.message:'Family selection could not be derived';render();}}})();return;
  }
  if (form.matches('#compose-form')) {
    event.preventDefault();
    captureComposeDraft(form as HTMLFormElement);
    const generation=productEditorGeneration,session=sessionGeneration,navigation=navigationGeneration,sequence=++productEditorRequestSequence;productEditorBusy=true;render();
    void (async()=>{try{const starter=await api('/platform-api/products/compose','POST',{draft:{...composeDraft,selected:[...composeDraft.selected]}});if(generation!==productEditorGeneration||session!==sessionGeneration||navigation!==navigationGeneration||sequence!==productEditorRequestSequence||!connected||route!=='products')return;productEditorBusy=false;composed=null;actionError='Starter loaded into the complete definition editor. Review the full JSON before previewing.';setProductEditorText(`${JSON.stringify(starter.product,null,2)}\n`);}catch(error){if(generation===productEditorGeneration&&session===sessionGeneration&&sequence===productEditorRequestSequence){productEditorBusy=false;productEditorDiagnostics=[error instanceof Error?error.message:'Composition starter failed'];render();}}})();
    return;
  }
  if (!form.matches('#pair-form')) return;
  event.preventDefault();
  const input = form.querySelector<HTMLInputElement>('[name="code"]');
  const code = input?.value ?? '';
  void (async () => {
    loginError = '';
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const response = await fetch('/platform-api/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Pairing failed');
      await loadOverview();
    } catch (error) {
      connected = false;
      catalogue=null;composed=null;
      loginError = error instanceof Error ? error.message : 'Pairing failed';
      render();
    }
  })();
});
window.addEventListener('hashchange',()=>activateRoute(location.hash.slice(1)||'overview'));
activateRoute(location.hash.slice(1)||'overview');
void (async () => {
  try {
    const response = await fetch('/platform-api/session', { credentials: 'same-origin' });
    if (!response.ok) { connected = false; render(); return; }
    await loadOverview();
  } catch (error) {
    connected = false;
    loginError = error instanceof Error ? error.message : 'Unable to connect to local Studio';
    render();
  }
})();
