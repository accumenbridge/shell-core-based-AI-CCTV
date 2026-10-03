import{createHash}from'node:crypto';import{readFile,writeFile}from'node:fs/promises';import{join,resolve}from'node:path';
const root=resolve(process.argv[2]),evidence=resolve(process.argv[3]),manifestPath=join(evidence,'MANIFEST.json'),m=JSON.parse(await readFile(manifestPath,'utf8'));
const prior=join(root,'evidence','freeze06-run-01','focused-tests.raw.txt'),raw=await readFile(prior),sha=createHash('sha256').update(raw).digest('hex');
if(raw.length!==7295||sha!=='b30e6ff94ac4eced3c5467c765a7213327c8dec19ac466f8ad54ed6ec9b62c0f')throw Error(`Freeze06 raw output identity mismatch ${raw.length}/${sha}`);
m.priorFailures.find(x=>x.run==='freeze06-run-01').sha256=sha;
const bytes=Buffer.from(JSON.stringify(m,null,2)+'\n');await writeFile(manifestPath,bytes);console.log(JSON.stringify({manifestPath,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),freeze06RawBytes:raw.length,freeze06RawSha256:sha},null,2));
