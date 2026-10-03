import { readFile, writeFile } from 'node:fs/promises';
const path='D:/Veyviz-code/veyviz-quadbridge-product/tests/veyviz-snapshot.test.mjs';
const raw=await readFile(path,'utf8'),eol=raw.includes('\r\n')?'\r\n':'\n';
let text=raw.replace(/\r\n/g,'\n');
const old="  const trackedBuildFile = Object.keys(release.backend)[0];\n  const producerBuildFile = join(producerRoot, ...trackedBuildFile.split('/'));\n  const originalBuildBytes = await readFile(producerBuildFile);";
const next="  const trackedBuildFile = 'modules/veyviz-sources/dist/index.js';\n  assert.equal(Object.prototype.hasOwnProperty.call(release.backend, trackedBuildFile), true, 'the reviewed source-module JavaScript output is bound into the release inventory');\n  const producerBuildFile = join(producerRoot, ...trackedBuildFile.split('/'));\n  assert.equal(existsSync(producerBuildFile), true, 'the selected reviewed backend JavaScript output exists before tampering');\n  const originalBuildBytes = await readFile(producerBuildFile);";
const n=text.split(old).length-1;if(n!==1)throw Error(`Expected unique tracked backend selection block, found ${n}`);
text=text.replace(old,next);await writeFile(path,text.split('\n').join(eol),'utf8');console.log('Selected and asserted the explicit reviewed backend JS output.');
