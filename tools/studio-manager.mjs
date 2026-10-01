/** Local developer operator, not a Product API. Fixed commands; new source directories only.
 * Running products use exported snapshots so rebuilding source cannot modify their served code.
 */
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { importProduct } from './product-source.mjs';
import { readCatalogue, validateProduct } from './studio-catalogue.mjs';
import { validProductId } from '../packages/composition/dist/studio.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fingerprint=value=>createHash('sha256').update(value).digest('hex');
export function stopTree(child) {
    if(!child?.pid || child.exitCode!==null) return;
    try {
        if(process.platform==='win32') spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
        else process.kill(-child.pid,'SIGTERM');
    } catch { child.kill('SIGTERM'); }
}
export class StudioManager {
    constructor(root,stateRoot=join(root,'.local/studio')) {this.root=resolve(root);this.stateRoot=resolve(stateRoot);this.jobs=new Map();this.builds=new Map();this.running=new Map();this.active=null;this.commands=new Set();this.closed=false;this.staging=0;this.launchStdio='inherit';}
    async catalogue(){return readCatalogue(this.root);}
    async save(value){if(this.closed||this.active||this.staging)throw Error('Wait for the active build before saving source');this.active='SOURCE_WRITE';try{return await importProduct(this.root,value);}finally{this.active=null;}}
    async run(args,job,{cwd=this.root,timeout=120000}={}) {
        if(this.closed)throw Error('Studio is shutting down');
        return new Promise((resolve,reject)=>{
            const child=spawn(process.execPath,args,{cwd,env:{...process.env,NODE_ENV:'development'},detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
            this.commands.add(child);let output='';let expired=false;
            const append=d=>{output=(output+d.toString()).slice(-65536);if(job)job.log=output;};
            child.stdout.on('data',append);child.stderr.on('data',append);
            const timer=setTimeout(()=>{expired=true;stopTree(child);},timeout);
            child.once('error',e=>{clearTimeout(timer);this.commands.delete(child);reject(e);});
            child.once('exit',code=>{clearTimeout(timer);this.commands.delete(child);if(code===0&&!expired)resolve(output);else reject(Error(expired?'Local build exceeded its time budget':`Local command failed (${code}). ${output.slice(-2500)}`));});
        });
    }
    build(productId) {
        if(!validProductId(productId))throw Error('Invalid product');
        if(this.active||this.staging||this.closed)throw Error('Another build is active or Studio is stopping');
        const job={id:randomUUID(),productId,status:'BUILDING',phase:'Compile registered source',startedAt:new Date().toISOString(),log:''};
        this.active=job.id;this.jobs.set(job.id,job);
        while(this.jobs.size>40)this.jobs.delete(this.jobs.keys().next().value);
        job.promise=(async()=>{
            try{
                const catalogue=await this.catalogue();
                const product=catalogue.products.find(p=>p.id===productId);if(!product)throw Error('Product source not found');
                validateProduct(product,catalogue.modules,catalogue.solutions);
                await this.run(['tools/build.mjs'],job);
                job.phase='Export immutable local runtime';
                const built=await this.stage(productId,job);this.builds.set(productId,built);
                job.status='BUILT';job.phase='Build complete; not running';job.release=built.release;
            }catch(e){job.status='FAILED';job.error=e.message;}
            finally{job.finishedAt=new Date().toISOString();this.active=null;await this.record(job);}
        })();
        return this.job(job.id);
    }
    async stage(productId,job) {
        const raw=await readFile(join(this.root,'.artifacts',productId,'release.json'),'utf8');
        const release=fingerprint(raw),path=join(this.stateRoot,'assemblies',`${productId}-${release.slice(0,16)}-${randomUUID().slice(0,8)}`);
        await mkdir(join(this.stateRoot,'assemblies'),{recursive:true,mode:0o700});
        await this.run(['tools/factory.mjs','assemble',productId,path],job);
        const source=await readFile(join(path,'.artifacts',productId,'plan.json'),'utf8');
        return {productId,release,path,plan:JSON.parse(source),builtAt:new Date().toISOString()};
    }
    async record(job) {await mkdir(join(this.stateRoot,'jobs'),{recursive:true,mode:0o700});await writeFile(join(this.stateRoot,'jobs',`${job.id}.json`),JSON.stringify(this.job(job.id),null,2)+'\n',{mode:0o600});}
    job(id){const j=this.jobs.get(id);if(!j)throw Error('Build job not found');const {promise,...data}=j;return data;}
    async launch(productId) {
        if(!validProductId(productId))throw Error('Invalid product');
        if(this.closed||this.active)throw Error('Wait for the current build');
        if(this.running.has(productId))throw Error('This Studio already owns an instance; stop it before starting another');
        const state={productId,status:'STARTING',url:null};this.running.set(productId,state);this.staging++;
        try{
            // Stage already-compiled supplied products without requiring a compiler download.
            let built=this.builds.get(productId);
            if(!built){built=await this.stage(productId);this.builds.set(productId,built);}
            if(built.plan.bindings.some(b=>b.mode==='http'))throw Error('CONNECTED_SETUP_REQUIRED: the Studio launcher supports local bindings only. Export this definition and use the reviewed connected local profile with its destination running; no remote credentials are collected by the Studio.');
            const port=await new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
            const data=join(this.stateRoot,'data',productId,built.release.slice(0,16));
            const child=spawn(process.execPath,[join(built.path,'tools/demo.mjs'),'--product',productId,'--port',String(port),'--data-root',data],{cwd:built.path,env:{...process.env,NODE_ENV:'development'},detached:process.platform!=='win32',stdio:this.launchStdio});
            state.child=child;state.release=built.release;state.url=`http://127.0.0.1:${port}`;state.data=data;
            state.done=new Promise(resolve=>{child.once('error',e=>{state.status='FAILED';state.error=e.message;resolve();});child.once('exit',code=>{if(state.status!=='STOPPED')state.status=code===0?'STOPPED':'FAILED';resolve();});});
            for(let n=0;n<150;n++){
                if(this.closed||state.status==='FAILED'||state.status==='STOPPED')throw Error('Application stopped before startup');
                try {const r=await fetch(`${state.url}/api/health`,{signal:AbortSignal.timeout(500)});if(r.ok&&(await r.json()).api==='READY'){state.status='RUNNING';return this.view(state);}}catch{}
                await sleep(100);
            }
            throw Error('Application did not become API-ready within 15 seconds');
        }catch(e){state.status='FAILED';state.error=e.message;stopTree(state.child);throw e;}finally{this.staging--;}
    }
    view(s){return {productId:s.productId,status:s.status,url:s.url,release:s.release??null,error:s.error??null,readiness:s.status==='RUNNING'?'API_READY_WORKFLOW_NOT_YET_PROVEN':'NOT_READY',credentials:'Generated credentials are printed in the terminal. Studio never returns service tokens.'};}
    status(){return {products:[...this.running.values()].map(s=>this.view(s)),builds:[...this.builds.values()].map(({productId,release,builtAt})=>({productId,release,builtAt})),jobs:[...this.jobs.keys()].map(id=>this.job(id)),activeJob:this.active};}
    async stop(productId){const s=this.running.get(productId);if(!s)return {productId,status:'STOPPED'};s.status='STOPPED';stopTree(s.child);await Promise.race([s.done??Promise.resolve(),sleep(4000)]);this.running.delete(productId);return {productId,status:'STOPPED'};}
    async close(){this.closed=true;for(const c of this.commands)stopTree(c);await Promise.all([...this.running.keys()].map(id=>this.stop(id)));await Promise.all([...this.jobs.values()].map(j=>j.promise));}
}
