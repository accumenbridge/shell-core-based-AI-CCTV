import type { Workspace } from '@quadbridge/contracts';
import { el, field, heading, section, formAction, button, statistic, emptyState } from '@quadbridge/web-shell/dom';
const labels:Record<string,string>={DESTINATION_COMMITTED:'Destination confirmed',ACCEPTANCE_UNKNOWN:'Confirmation needed',QUEUED:'Waiting to send',FAILED:'Local attempt failed',SUCCEEDED:'Local completion recorded',CANCELLED:'Local attempt cancelled',NOT_SENT:'Not sent',RECONCILIATION_REQUIRED:'Earlier-protocol review required'};
export const workspace: Workspace = { mount(ctx) {
    ctx.root.append(heading('Cross-product handoffs','Choose a permitted document and request a linked action. The destination remains the owner of its record.'));
    const stats=el('div','stat-grid');ctx.root.append(stats);
    const flow=el('div','handoff-flow');flow.append(el('span','flow-node','Knowledge'),el('span','flow-link','→'),el('span','flow-node','Bound public operation'),el('span','flow-link','→'),el('span','flow-node','Service Desk'));ctx.root.append(flow);
    const grid=el('div','grid'),create=section(),list=section();grid.append(create,list);ctx.root.append(grid);
    create.append(el('h3','','Create a linked request'));
    const readiness=el('p','muted','Checking permitted documents and connection prerequisites…');readiness.setAttribute('role','status');create.append(readiness);
    const form=el('form'),wrap=el('label','field'),select=el('select'),reason=field('Reason for the service request','reason',true);
    select.name='documentId';select.required=true;select.disabled=true;
    wrap.append(el('span','field-label','Source document'),select);form.append(wrap,reason.wrap);
    let available=false,disposed=false,optionsGeneration=0;
    const refresh=async()=>{
        const data=await ctx.api.get('/api/handoffs') as {items:{id:string;title:string;outcome:string;state:string;target_ref:unknown;delivery:{state:string;error:string|null}}[]};
        if(ctx.signal.aborted||disposed)return;
        stats.replaceChildren(statistic('Loaded handoffs',data.items.length,'Current response · current tenant'),statistic('Destination confirmed',data.items.filter(x=>x.outcome==='DESTINATION_COMMITTED').length,'Separate from local job success'),statistic('Confirmation needed',data.items.filter(x=>x.outcome==='ACCEPTANCE_UNKNOWN').length,'Check the original receipt'));
        list.replaceChildren(el('h3','','Requests and confirmations'));
        if(!data.items.length)list.append(emptyState('No linked requests yet.','Choose a permitted source document to begin.'));
        for(const item of data.items){
            const node=el('article','list-item');node.append(el('div','item-meta',labels[item.outcome]||item.outcome),el('h3','',item.title));
            node.append(el('p','muted',`Local execution: ${labels[item.delivery.state]||item.delivery.state}. Source workflow: ${item.state==='ACCEPTED'?'Destination linked':'Pending owner completion'}.`));
            const details=el('details'),summary=el('summary','','Technical details');details.append(summary,el('p','receipt',item.id));
            if(item.target_ref)details.append(el('p','receipt',JSON.stringify(item.target_ref)));if(item.delivery.error)details.append(el('p','error',`Local attempt: ${item.delivery.error}`));node.append(details);
            if(item.outcome==='DESTINATION_COMMITTED'&&item.delivery.state!=='SUCCEEDED')node.append(el('p','muted','The destination committed. Local completion is separate; do not send a new request.'));
            if(item.outcome==='ACCEPTANCE_UNKNOWN'){
                node.append(el('p','muted','The original request may have committed. Ending retries does not establish that nothing happened.'));
                if(ctx.permissions.includes('handoff.reconcile')){
                    const check=button('Check original receipt',()=>{check.disabled=true;void ctx.api.post('/api/handoffs/reconcile',{id:item.id}).then(refresh).catch(e=>{if(!ctx.signal.aborted)ctx.notice(e.message);}).finally(()=>{if(!ctx.signal.aborted)check.disabled=false;});});node.append(check);
                }
            }
            list.append(node);
        }
    };
    const loadOptions=async()=>{
        const generation=++optionsGeneration;available=false;select.disabled=true;
        try{
            const result=await ctx.api.get('/api/handoffs/options') as {documents:{id:string;title:string;version:number}[];connection:{state:string;message?:string}};
            if(ctx.signal.aborted||disposed||generation!==optionsGeneration)return;
            const old=select.value;select.replaceChildren();const placeholder=el('option','','Choose a source document');placeholder.value='';select.append(placeholder);
            for(const doc of result.documents){const option=el('option','',`${doc.title} · v${doc.version}`);option.value=doc.id;select.append(option);}
            if(result.documents.some(d=>d.id===old))select.value=old;
            available=result.connection.state==='READY';select.disabled=!available;
            readiness.className=available?'muted':'error';readiness.textContent=available?(result.documents.length?'Connection prerequisites checked. Authorization is checked again when you submit.':'No permitted documents in this returned list. Add a document in Knowledge, then refresh.'):(result.connection.message||'Connection is not ready. No new handoff will be submitted.');
        }catch(e){if(!ctx.signal.aborted&&!disposed&&generation===optionsGeneration){select.replaceChildren();readiness.className='error';readiness.textContent=(e as Error).message;}}
    };
    create.append(button('Refresh documents & connection',()=>void loadOptions()));
    if(ctx.permissions.includes('handoff.create')){
        formAction(form,'Request Service Desk action',async()=>{if(!available)throw Error('Resolve the connection prerequisites before submitting.');await ctx.api.post('/api/handoffs',{documentId:select.value,reason:reason.input.value});reason.input.value='';await refresh();},ctx.signal,ctx.notice);create.append(form);
    }else create.append(el('p','muted','Read access only.'));
    void loadOptions();void refresh().catch(e=>{if(!ctx.signal.aborted)ctx.notice(e.message);});
    const timer=setInterval(()=>void refresh().catch(e=>{if(!ctx.signal.aborted)ctx.notice(e.message);}),2000);
    return()=>{disposed=true;optionsGeneration++;clearInterval(timer);};
} };
