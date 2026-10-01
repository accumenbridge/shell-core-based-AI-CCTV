import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrainError, checkpoint, context, preflight, record, repairView, validate } from './brain-core.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
    return [
        'Project Brain local workflow CLI',
        '',
        'Usage:',
        '  npm run brain -- [--root <repository>] validate [--json]',
        '  npm run brain -- [--root <repository>] preflight [--json]',
        '  npm run brain -- [--root <repository>] context [--task <TASK-ID>] [--json]',
        '  npm run brain -- [--root <repository>] record --input <repo-relative.json> [--json]',
        '  npm run brain -- [--root <repository>] checkpoint --input <repo-relative.json> --expected-revision <N> [--json]',
        '  npm run brain -- [--root <repository>] checkpoint --render [--json]',
        '',
        'Recipe argv is inert metadata. This CLI never executes checks or dispatches agents.',
        'Record inputs are reported evidence; they do not authenticate execution, identity, or approval.',
        'Preflight checks project record integrity and current plan/task readiness before platform implementation.'
    ].join('\n');
}

function parseArgs(argv) {
    const options = { root: defaultRoot, json: false, command: null, input: null, task: null, expectedRevision: null, render: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') { options.command = 'help'; continue; }
        if (arg === '--json') { options.json = true; continue; }
        if (arg === '--render') { options.render = true; continue; }
        if (['--root', '--input', '--task', '--expected-revision'].includes(arg)) {
            const value = argv[++index];
            if (!value || value.startsWith('--')) throw new BrainError('CLI_USAGE', `${arg} needs a value.`);
            if (arg === '--root') options.root = resolve(value);
            else if (arg === '--input') options.input = value;
            else if (arg === '--task') options.task = value;
            else {
                if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)))
                    throw new BrainError('CLI_USAGE', '--expected-revision must be a non-negative safe integer.');
                options.expectedRevision = Number(value);
            }
            continue;
        }
        if (arg.startsWith('-')) throw new BrainError('CLI_USAGE', `Unknown option ${arg}.`);
        if (options.command) throw new BrainError('CLI_USAGE', `Unexpected argument ${arg}.`);
        options.command = arg;
    }
    if (!options.command) options.command = 'help';
    return options;
}

function printResult(options, result) {
    if (options.json || ['record', 'checkpoint'].includes(options.command)) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    if (options.command === 'validate') {
        process.stdout.write(`${result.status}${result.summary ? ` — revision ${result.summary.revision}, ${result.summary.recordCount} records, ${result.summary.eventCount} committed events` : ''}\n`);
        for (const warning of result.warnings) process.stdout.write(`WARNING: ${warning}\n`);
        for (const error of result.errors) process.stdout.write(`${error.code}: ${error.message}\n`);
        printReadiness(result.executionReadiness);
        return;
    }
    if (options.command === 'preflight') {
        process.stdout.write(`Workflow integrity: ${result.integrity.status}\n`);
        printReadiness(result.executionReadiness);
        process.stdout.write(`Platform implementation admission: ${result.admission}\n`);
        if (result.integrity.status !== 'VALID') for (const error of result.integrity.errors) process.stdout.write(`${error.code}: ${error.message}\n`);
        if (result.executionReadiness?.status === 'NOT_READY') for (const item of result.executionReadiness.reasons) process.stdout.write(`${item.code}: ${item.message}\n`);
        return;
    }
    if (options.command === 'context') {
        process.stdout.write(`Task: ${result.selectedTaskId}\n`);
        process.stdout.write(`Contract digest: ${result.contractDigest ?? 'unavailable'}\n`);
        process.stdout.write(`Current candidate: ${result.candidate?.digest ?? 'unavailable'}\n`);
        if (result.checkpoint?.currentTasks) {
            for (const [label, task] of Object.entries(result.checkpoint.currentTasks)) {
                if (!task) continue;
                process.stdout.write(`${label}: ${task.taskId} — ${task.status}\n`);
                process.stdout.write(`  Next action: ${task.nextAction}\n`);
                if (task.blockers.length) process.stdout.write(`  Blockers: ${task.blockers.join('; ')}\n`);
                if (task.gates.length) process.stdout.write(`  Gates: ${task.gates.map(gate => `${gate.id}=${gate.status}`).join(', ')}\n`);
            }
        } else process.stdout.write('Checkpoint: not initialized\n');
        process.stdout.write(`Reported evidence assessment: ${result.evidenceAssessment.status}\n`);
        for (const reason of result.evidenceAssessment.reasons) process.stdout.write(`  ${reason}\n`);
        process.stdout.write(`Source task: ${result.sourceTask.path}${result.sourceTask.truncated ? ' (bounded excerpt shown in JSON output)' : ''}\n`);
        printReadiness(result.executionReadiness);
        return;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function printReadiness(readiness) {
    if (!readiness) { process.stdout.write('Execution readiness: UNAVAILABLE\n'); return; }
    process.stdout.write(`Execution readiness: ${readiness.status}\n`);
    if (readiness.canonicalTask?.taskId) {
        process.stdout.write(`  Canonical task: ${readiness.canonicalTask.taskId} (${readiness.canonicalTask.sourceTaskRef ?? 'source unavailable'})\n`);
        process.stdout.write(`  Planning focus: ${readiness.focus ? `${readiness.focus.nodeId} — ${readiness.focus.title}` : 'not selected'}\n`);
    }
    if (readiness.legacyCompatibility) process.stdout.write('  No atlas is configured; legacy workflow is available without plan governance.\n');
    for (const item of readiness.reasons ?? []) process.stdout.write(`  ${item.code}: ${item.message}\n`);
}

async function main(argv = process.argv.slice(2)) {
    const jsonWasRequested = argv.includes('--json');
    let options;
    try { options = parseArgs(argv); }
    catch (error) {
        const result = { ok: false, error: { code: error.code ?? 'CLI_USAGE', message: error.message } };
        if (jsonWasRequested) process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
        else process.stderr.write(`${result.error.code}: ${result.error.message}\n\n${usage()}\n`);
        process.exitCode = 2;
        return;
    }
    if (options.command === 'help') {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    try {
        let result;
        if (options.command === 'validate') {
            result = await validate(options.root);
            printResult(options, result);
            if (result.status !== 'VALID') process.exitCode = 1;
            return;
        }
        if (options.command === 'preflight') {
            if (options.input || options.task || options.expectedRevision !== null || options.render)
                throw new BrainError('CLI_USAGE', 'preflight accepts only --root and --json.');
            result = await preflight(options.root);
            printResult(options, result);
            if (!result.readyForImplementation) process.exitCode = 1;
            return;
        }
        if (options.command === 'context') {
            result = await context(options.root, options.task ?? undefined);
            printResult(options, result);
            return;
        }
        if (options.command === 'record') {
            if (!options.input) throw new BrainError('CLI_USAGE', 'record requires --input <repo-relative.json>.');
            if (options.task || options.expectedRevision !== null || options.render)
                throw new BrainError('CLI_USAGE', 'record accepts only --root, --input, and --json.');
            result = await record(options.root, options.input);
            printResult(options, result);
            return;
        }
        if (options.command === 'checkpoint') {
            if (options.render) {
                if (options.input || options.expectedRevision !== null || options.task)
                    throw new BrainError('CLI_USAGE', 'checkpoint --render does not accept --input, --task, or --expected-revision.');
                result = await repairView(options.root);
            } else {
                if (!options.input || options.expectedRevision === null)
                    throw new BrainError('CLI_USAGE', 'checkpoint requires --input <repo-relative.json> and --expected-revision <N>.');
                if (options.task) throw new BrainError('CLI_USAGE', 'checkpoint does not accept --task.');
                result = await checkpoint(options.root, options.input, options.expectedRevision);
            }
            printResult(options, result);
            return;
        }
        throw new BrainError('CLI_USAGE', `Unknown command ${options.command}.`);
    } catch (error) {
        const result = { ok: false, error: { code: error.code ?? 'WORKFLOW_ERROR', message: error.message, ...(error.details ? { details: error.details } : {}) } };
        if (options.json) process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
        else process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
        process.exitCode = error.code === 'CLI_USAGE' ? 2 : 1;
    }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();

export { main, usage };
