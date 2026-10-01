import {setImmediate as nextTurn} from 'node:timers/promises';
import {startShell} from '../../packages/web-shell/dist/index.js';
export class Node {constructor(tag){this.tag=tag;this.children=[];this.listeners=new Map();this.attributes={};this.className='';this.value='';this.hidden=false;this._text='';}
 set textContent(s){this._text=String(s);this.children=[];}get textContent(){return this._text+this.children.map(c=>c.textContent??String(c)).join('');}
 append(...xs){this.children.push(...xs);}replaceChildren(...xs){this._text='';this.children=[...xs];}
 setAttribute(k,v){this.attributes[k]=v;}getAttribute(k){return this.attributes[k];}
 addEventListener(k,fn){const a=this.listeners.get(k)??[];a.push(fn);this.listeners.set(k,a);}removeEventListener(k,fn){this.listeners.set(k,(this.listeners.get(k)??[]).filter(x=>x!==fn));}
 emit(k,e={}){for(const fn of this.listeners.get(k)??[])fn({preventDefault(){},target:this,...e});}
}
const all=n=>[n,...n.children.filter(x=>x instanceof Node).flatMap(all)];
export const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}});
export const boot=(tenant='tenant-a')=>({scope:{productId:'example',instanceId:'example-one',tenantId:tenant},actor:{id:'admin',kind:'user'},tenants:['tenant-a','tenant-b'],permissions:['example.read','example.write'],product:{id:'example',title:'Example',description:'',layout:'sidebar',version:'0.1.0'},abi:'quadbridge.module.v1',modules:[{id:'example',version:'0.1.0',mode:'enabled'}],operations:[{method:'GET',path:'/api/records',moduleId:'example'},{method:'POST',path:'/api/records',moduleId:'example'}],workspaces:[{id:'example.main',label:'Records',path:'/records',moduleId:'example',export:'workspace'}]});
export async function flush(){for(let i=0;i<10;i++)await nextTurn();}
export async function harness(fn){const keys=['document','window','location','fetch','setInterval','clearInterval'];const old=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));const timers=new Map();let seq=0;
 const win=new Node('window'),loc={hash:'',origin:'http://127.0.0.1:4300'},root=new Node('root');
 globalThis.document={createElement:tag=>new Node(tag)};globalThis.window=win;globalThis.location=loc;
 globalThis.setInterval=(f,ms)=>{const id=++seq;timers.set(id,{f,ms});return id;};globalThis.clearInterval=id=>timers.delete(id);
 const env={root,win,loc,timers,all:()=>all(root),content:()=>all(root).find(n=>n.className==='content'),async refresh(){for(const t of timers.values())t.f();await flush();}};let stop;
 try{return await fn(env,opts=>stop=startShell({root,title:'Example',...opts}));}finally{stop?.();for(const[k,d]of old)d?Object.defineProperty(globalThis,k,d):delete globalThis[k];}}
