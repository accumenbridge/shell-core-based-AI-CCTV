import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeVerificationReport, maintainedSourceFingerprint } from './verify-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, 'evidence');
await mkdir(evidence, { recursive: true });
const reportPath = join(evidence, 'last_run.json');
await rm(reportPath, { force: true });

function run(args) {
    try {
        const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
        return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    } catch (error) {
        return { status: null, error, output: '' };
    }
}

const build = run(['tools/build.mjs']);
await writeFile(join(evidence, 'build.log'), build.output);

let discoveredFiles;
let discoveryError;
let tests;
if (build.status === 0 && !build.error && !build.signal) {
    try {
        discoveredFiles = (await readdir(join(root, 'tests'), { withFileTypes: true }))
            .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
            .map(entry => `tests/${entry.name}`)
            .sort();
        if (discoveredFiles.length > 0)
            tests = run(['--test', '--test-concurrency=1', '--test-reporter=tap', ...discoveredFiles]);
    } catch (error) {
        discoveryError = error;
    }
}
await writeFile(join(evidence, 'tests.log'), tests?.output ?? (build.status === 0 ? 'NOT_RUN: no test process was started.\n' : 'NOT_RUN: build did not complete successfully.\n'));

let typescript;
const preparationErrors = [];
if (build.status === 0 && !build.error && !build.signal) {
    try { typescript = JSON.parse(await readFile(join(root, 'node_modules/typescript/package.json'), 'utf8')).version; }
    catch (error) { preparationErrors.push(`typescript_metadata: ${error.message}`); }
}
let sourceFingerprint;
try { sourceFingerprint = await maintainedSourceFingerprint(root); }
catch (error) { preparationErrors.push(`source_fingerprint: ${error.message}`); }
const result = makeVerificationReport({
    buildResult: build,
    testResult: tests,
    discoveredFiles,
    discoveryError,
    sourceFingerprint,
    typescript,
    preparationErrors
});
await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (result.status === 'FAILED') process.exitCode = 1;
