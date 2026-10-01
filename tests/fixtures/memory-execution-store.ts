/** Independent ephemeral conformance adapter. Not a durable or production queue. */
import { PlatformError, canonical, type Job, type PreparedJob, type JobExecutionStore } from '@quadbridge/contracts';
export class MemoryExecutionStore implements JobExecutionStore {
    jobs = new Map<string,Job>();
    domain = new Map<string,unknown>();
    private serial=0;
    constructor(private readonly clock:()=>number=Date.now){}
    add(id:string) {
        const now=this.clock();
        const job:Job={id,tenant:'tenant-a',kind:'sample',payload:'{}',actor_id:'user',actor_kind:'user',permission:'write',state:'QUEUED',attempt:0,lease_token:null,lease_until:null,deadline:now+100000,max_attempts:3,error:null,result:null,run_at:now,created:now};
        this.jobs.set(id,job);return job;
    }
    claim(worker:string,leaseMs:number,canStart:(job:Job)=>boolean):Job|undefined {
        const now=this.clock(),job=[...this.jobs.values()].find(j=>j.deadline>now&&j.attempt<j.max_attempts&&((j.state==='QUEUED'&&j.run_at<=now)||(j.state==='RUNNING'&&(j.lease_until??0)<=now))&&canStart(j));
        if(!job)return undefined;
        Object.assign(job,{state:'RUNNING',attempt:job.attempt+1,lease_token:`${worker}.${++this.serial}`,lease_until:now+leaseMs});return {...job};
    }
    assertCurrent(job:Job){const actual=this.jobs.get(job.id);if(!actual||actual.state!=='RUNNING'||actual.lease_token!==job.lease_token||(actual.lease_until??0)<=this.clock()||actual.deadline<=this.clock())throw new PlatformError('STALE_ATTEMPT','No completion ownership');}
    renew(job:Job,leaseMs:number){try{this.assertCurrent(job);this.jobs.get(job.id)!.lease_until=this.clock()+leaseMs;return true;}catch{return false;}}
    finish(job:Job,prepared:PreparedJob){
        this.assertCurrent(job);const records=structuredClone(this.jobs),data=structuredClone(this.domain);
        try{const result=prepared.commit();const encoded=canonical(result??null);Object.assign(this.jobs.get(job.id)!,{state:'SUCCEEDED',result:encoded,lease_token:null,lease_until:null});return result;}
        catch(e){this.jobs=records;this.domain=data;throw e;}
    }
    fail(job:Job,error:string,retry:boolean){const actual=this.jobs.get(job.id);if(!actual||actual.lease_token!==job.lease_token)return;Object.assign(actual,{state:retry&&actual.attempt<actual.max_attempts&&actual.deadline>this.clock()?'QUEUED':'FAILED',error,lease_token:null,lease_until:null});}
}
