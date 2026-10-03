import{readFile,writeFile}from'node:fs/promises';
const path='D:/Veyviz-code/veyviz-quadbridge-product/tests/veyviz-snapshot.test.mjs',raw=await readFile(path,'utf8'),eol=raw.includes('\r\n')?'\r\n':'\n';let text=raw.replace(/\r\n/g,'\n');
const old='  await assertRefusedBeforeFork(producerRoot, dataRoot, /digest mismatch|release|digest/i);';
const next=String.raw`  await assertRefusedBeforeFork(producerRoot, dataRoot, /digest mismatch|release|digest|Artifact drift: modules\/veyviz-sources\/dist\/index\.js/i);`;
const n=text.split(old).length-1;if(n!==1)throw Error(`Expected one stale-output refusal assertion, found ${n}`);text=text.replace(old,next);await writeFile(path,text.split('\n').join(eol),'utf8');console.log('Added the exact compiled-entry Artifact drift refusal message.');
