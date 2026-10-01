/** Product/solution-owned translation. No foreign persistence or source-user impersonation. */
import { PlatformError } from '@quadbridge/contracts';
import { httpCommand, localCommand } from '@quadbridge/connections';
export async function bind({binding,config,productId,publicService,context}) {
  if(binding.scope!=='application')throw new PlatformError('INCOMPATIBLE','This reference solution uses application-scoped ports');
  if(binding.contract==='knowledge.document.read.v1'&&binding.mode==='local'){
    return {list:async ctx=>publicService(binding.contract,binding.implementation).list(context(ctx.actor,ctx.tenantId,binding.implementation,ctx.signal,ctx.requestId)),read:async(ctx,documentId)=>publicService(binding.contract,binding.implementation).get(
      context(ctx.actor,ctx.tenantId,binding.implementation,ctx.signal,ctx.requestId),documentId)};
  }
  if(binding.contract==='desk.requests.create.v2'){
    const c=config.connections?.[binding.instanceId];
    if(!c||c.mode!==binding.mode)throw new PlatformError('INCOMPATIBLE','Approved connection binding required');
    const declaration={id:binding.instanceId,revision:c.revision,sourceProduct:productId,destinationProduct:c.destinationProduct,destinationInstance:c.destinationInstance,serviceActor:c.serviceActor,
      contract:binding.contract,mode:c.mode,tenantMap:c.tenantMap,baseUrl:c.baseUrl,path:'/api/requests/commit',serviceToken:c.serviceToken};
    const protocol={contract:binding.contract,resourceType:'desk.request',receiptPath:'/api/requests/receipt'};
    const destinationContext=(tenant,signal)=>context({id:c.serviceActor,kind:'service'},tenant,binding.implementation,signal);
    const command=c.mode==='http'?httpCommand(declaration,protocol):localCommand(declaration,protocol,{
      identity:tenant=>({productId,instanceId:config.instanceId,tenantId:tenant}),
      invoke:(tenant,input,key,signal)=>publicService(binding.contract,binding.implementation).create(destinationContext(tenant,signal),input,key),
      lookup:(tenant,key,signal)=>publicService(binding.contract,binding.implementation).lookup(destinationContext(tenant,signal),key)
    });
    return {command,revision:c.revision,destinationInstance:c.destinationInstance,
      async ready(ctx) {
        const target=command.target(ctx.tenantId);
        if(c.mode==='local') {
          const dest=destinationContext(target.tenantId,ctx.signal);
          dest.assertAllowed('desk.create','write'); dest.assertAllowed('desk.receipts.read','read');
        } else {
          const response=await fetch(new URL('/api/bootstrap',c.baseUrl),{redirect:'error',signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(5000)]),headers:{Authorization:`Bearer ${c.serviceToken}`,'X-QB-Tenant':target.tenantId,'X-QB-Destination-Instance':target.instanceId,'X-QB-Destination-Product':target.productId,'X-QB-Destination-Principal':c.serviceActor}});
          if(response.status!==200) {await response.body?.cancel();throw new PlatformError(response.status===401||response.status===403?'DENIED':'UNAVAILABLE','Destination prerequisites are unavailable');}
          const reader=response.body.getReader();const parts=[];let n=0;
          try{while(true){const item=await reader.read();if(item.done)break;n+=item.value.length;if(n>65536){await reader.cancel();throw new PlatformError('INCOMPATIBLE','Destination bootstrap exceeds budget');}parts.push(item.value);}}finally{reader.releaseLock();}
          const data=JSON.parse(Buffer.concat(parts).toString('utf8'));
          if(data.scope?.productId!==target.productId||data.scope?.instanceId!==target.instanceId||data.scope?.tenantId!==target.tenantId||data.actor?.id!==c.serviceActor||data.actor?.kind!=='service')throw new PlatformError('INCOMPATIBLE','Destination scope differs from the binding');
          if(!['desk.create','desk.receipts.read'].every(p=>data.permissions?.includes(p)))throw new PlatformError('DENIED','Configured destination identity lacks required permissions');
        }
        return {state:'READY',destination:target,checkedAt:new Date().toISOString(),meaning:'Prerequisite read only. Not an execution permit or committed operation.'};
      }
    };
  }
  throw new PlatformError('INCOMPATIBLE',`No solution adapter for ${binding.contract}`);
}
