import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const excludedComponents = new Set([
    '.git', '.brain', '.codex', 'analysis', 'artifacts', '.artifacts', 'coverage',
    'dist', 'evidence', 'exports', 'generated', 'node_modules', 'reference',
    'test-results', '__pycache__', '.local', '.env'
]);

export function shouldIncludeMaintainedPath(path) {
    const parts = String(path).replaceAll('\\', '/').split('/').filter(Boolean);
    if (parts.some(part => excludedComponents.has(part.toLowerCase()))) return false;
    const name = parts.at(-1)?.toLowerCase() ?? '';
    return name !== 'bundle_sha256.json' && !name.endsWith('.tsbuildinfo') && !name.endsWith('.log');
}

export async function maintainedFiles(root) {
    const files = [];
    async function visit(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const entry of entries) {
            const fullPath = join(directory, entry.name);
            const rel = relative(root, fullPath).replaceAll('\\', '/');
            if (!shouldIncludeMaintainedPath(rel) || entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) await visit(fullPath);
            else if (entry.isFile()) files.push({ fullPath, relativePath: rel });
        }
    }
    await visit(root);
    return files;
}

export async function maintainedSourceFingerprint(root) {
    const hash = createHash('sha256');
    for (const file of await maintainedFiles(root)) {
        hash.update(file.relativePath);
        hash.update('\0');
        hash.update(await readFile(file.fullPath));
    }
    return hash.digest('hex');
}

function invalid(reason, counts = null) {
    return { status: 'FAILED', reason, counts };
}

export function parseTapReport(output, discoveredFileCount) {
    if (!Number.isSafeInteger(discoveredFileCount) || discoveredFileCount < 1)
        return invalid('invalid_discovery_count');
    if (typeof output !== 'string' || !output.trim()) return invalid('empty_test_output');
    const lines = output.replaceAll('\r\n', '\n').split('\n');
    if (lines[0] !== 'TAP version 13') return invalid('missing_or_unknown_tap_version');

    const plans = lines.filter(line => /^\d+\.\.\d+$/.test(line));
    if (plans.length !== 1) return invalid('missing_or_ambiguous_plan');
    const planCount = Number(plans[0].slice(3));
    if (!Number.isSafeInteger(planCount) || planCount < 0) return invalid('malformed_plan');
    const resultLines = lines.filter(line => /^\s*(?:not )?ok \d+(?:\s|$)/.test(line));
    const rootResults = resultLines.filter(line => /^(?:not )?ok \d+(?:\s|$)/.test(line));
    if (rootResults.length !== planCount) return invalid('malformed_or_ambiguous_results');
    for (let index = 0; index < rootResults.length; index++) {
        const match = /^(?:not )?ok (\d+)(?:\s|$)/.exec(rootResults[index]);
        if (!match || Number(match[1]) !== index + 1) return invalid('malformed_or_ambiguous_results');
    }

    const names = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
    const values = Object.create(null);
    for (const name of names) {
        const matches = lines.filter(line => line.startsWith(`# ${name} `));
        if (matches.length !== 1) return invalid(matches.length ? 'ambiguous_summary' : 'missing_summary');
        const match = new RegExp(`^# ${name} (0|[1-9][0-9]*)$`).exec(matches[0]);
        if (!match) return invalid('malformed_summary');
        values[name] = Number(match[1]);
        if (!Number.isSafeInteger(values[name])) return invalid('malformed_summary');
    }
    const counts = {
        tests: values.tests, passed: values.pass, failed: values.fail,
        cancelled: values.cancelled, skipped: values.skipped, todo: values.todo
    };
    if (counts.tests < 1) return invalid('zero_tests', counts);
    if (counts.tests !== counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo)
        return invalid('inconsistent_counts', counts);
    if (resultLines.length !== counts.tests) return invalid('result_summary_mismatch', counts);
    const observed = { passed: 0, failedOrCancelled: 0, skipped: 0, todo: 0 };
    for (const line of resultLines) {
        if (/# SKIP(?:\s|$)/.test(line)) observed.skipped++;
        else if (/# TODO(?:\s|$)/.test(line)) observed.todo++;
        else if (/^\s*not ok \d+/.test(line)) observed.failedOrCancelled++;
        else if (/^\s*ok \d+/.test(line)) observed.passed++;
        else return invalid('malformed_or_ambiguous_results', counts);
    }
    if (observed.passed !== counts.passed || observed.skipped !== counts.skipped ||
        observed.todo !== counts.todo || observed.failedOrCancelled !== counts.failed + counts.cancelled)
        return invalid('result_summary_mismatch', counts);
    return { status: 'VALID', counts };
}

export function evaluateTestRun({ discoveredFiles, discoveryError, result }) {
    if (discoveryError) return invalid('discovery_error');
    if (!Array.isArray(discoveredFiles)) return invalid('unknown_discovery');
    if (discoveredFiles.length === 0) return invalid('zero_discovered_files');
    if (discoveredFiles.some(file => typeof file !== 'string' || !file.endsWith('.test.mjs')))
        return invalid('malformed_discovery');
    if (new Set(discoveredFiles).size !== discoveredFiles.length) return invalid('ambiguous_discovery');
    if (!result || typeof result !== 'object') return invalid('unknown_execution_result');
    if (result.error) return invalid('spawn_error');
    if (result.signal) return invalid('terminated_by_signal');
    if (!Number.isInteger(result.status)) return invalid('unknown_exit_status');

    const parsed = parseTapReport(result.output, discoveredFiles.length);
    if (parsed.status !== 'VALID') return parsed;
    if (result.status !== 0) return invalid('nonzero_test_exit', parsed.counts);
    if (parsed.counts.failed > 0) return invalid('test_failures', parsed.counts);
    if (parsed.counts.cancelled > 0) return invalid('test_cancellations', parsed.counts);
    if (parsed.counts.passed === 0) return invalid('no_completed_passing_tests', parsed.counts);
    return { status: 'PASSED', counts: parsed.counts };
}

export function makeVerificationReport({ buildResult, testResult, discoveredFiles, discoveryError, sourceFingerprint, preparationErrors = [], at = new Date().toISOString(), node = process.version, typescript }) {
    const buildPassed = Boolean(buildResult && !buildResult.error && !buildResult.signal && buildResult.status === 0);
    const tests = buildPassed
        ? evaluateTestRun({ discoveredFiles, discoveryError, result: testResult })
        : { status: 'NOT_RUN', reason: 'build_failed', counts: null };
    const validFingerprint = typeof sourceFingerprint === 'string' && /^[a-f0-9]{64}$/.test(sourceFingerprint);
    const passed = buildPassed && tests.status === 'PASSED' && validFingerprint && preparationErrors.length === 0;
    const claims = [];
    if (buildPassed) claims.push('The maintained TypeScript project build completed in this run.');
    if (tests.status === 'PASSED') {
        claims.push(`The current TAP run reported ${tests.counts.passed} passing tests across ${discoveredFiles.length} discovered test files.`);
        if (tests.counts.skipped || tests.counts.todo)
            claims.push(`The current TAP run also reported ${tests.counts.skipped} skipped and ${tests.counts.todo} TODO tests.`);
    }
    return {
        status: passed ? 'PASSED_FOR_LOCAL_FRAMEWORK_SCOPE' : 'FAILED',
        at, node, ...(typescript ? { typescript } : {}), sourceFingerprint: sourceFingerprint ?? null,
        checks: {
            typeScriptProjectBuild: buildPassed ? 'PASSED' : 'FAILED',
            tests: { status: tests.status, ...(tests.reason ? { reason: tests.reason } : {}), counts: tests.counts }
        },
        execution: {
            build: { exitCode: buildResult?.status ?? null, signal: buildResult?.signal ?? null, error: buildResult?.error?.message },
            tests: buildPassed ? { exitCode: testResult?.status ?? null, signal: testResult?.signal ?? null, error: testResult?.error?.message } : { status: 'NOT_RUN' }
        },
        currentRunEvidence: { claims },
        ...(preparationErrors.length ? { preparationErrors } : {}),
        ...(validFingerprint ? {} : { fingerprintStatus: 'UNAVAILABLE_OR_MALFORMED' })
    };
}
