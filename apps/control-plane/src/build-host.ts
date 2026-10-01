import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface WindowsBuildHostProfile {
  schema: 'quadbridge.local-build-host.v1';
  kind: 'powershell7-file-host';
  path: string;
  sha256: string;
  version: string;
  policy: 'RemoteSigned';
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT']) if (process.env[name]) env[name] = process.env[name];
  return env;
}

function exactProfile(value: unknown): WindowsBuildHostProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid profile');
  const profile = value as Record<string,unknown>;
  const keys = ['schema','kind','path','sha256','version','policy'].sort();
  if (Object.keys(profile).sort().join('\0') !== keys.join('\0') || profile.schema !== 'quadbridge.local-build-host.v1' ||
      profile.kind !== 'powershell7-file-host' || typeof profile.path !== 'string' || !isAbsolute(profile.path) ||
      typeof profile.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(profile.sha256) ||
      typeof profile.version !== 'string' || !/^7\.\d+\.\d+$/.test(profile.version) || profile.policy !== 'RemoteSigned')
    throw new Error('invalid profile');
  return profile as unknown as WindowsBuildHostProfile;
}

/** Reads the private per-checkout profile and checks ordinary policy; no system fallback is attempted. */
export function assertWindowsBuildHost(profileRoot: string, reviewedSourceRoot = profileRoot): WindowsBuildHostProfile | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const localDirectory = join(profileRoot,'.local');
    const localInfo = lstatSync(localDirectory);
    if (!localInfo.isDirectory() || localInfo.isSymbolicLink() || realpathSync(localDirectory).toLowerCase() !== resolve(localDirectory).toLowerCase()) throw new Error('private profile directory is unsafe');
    const profilePath = join(localDirectory,'platform-build-host.json');
    const profileInfo = lstatSync(profilePath);
    if (!profileInfo.isFile() || profileInfo.isSymbolicLink() || realpathSync(profilePath).toLowerCase() !== resolve(profilePath).toLowerCase()) throw new Error('private profile file is unsafe');
    const profile = exactProfile(JSON.parse(readFileSync(profilePath,'utf8')) as unknown);
    const executable = profile.path;
    const stat = lstatSync(executable);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(executable).toLowerCase() !== resolve(executable).toLowerCase()) throw new Error('host executable identity mismatch');
    const hash = createHash('sha256').update(readFileSync(executable)).digest('hex');
    if (hash !== profile.sha256) throw new Error('host executable hash mismatch');
    const script = join(reviewedSourceRoot,'tools','build-host-preflight.ps1');
    const scriptStat = lstatSync(script);
    if (!scriptStat.isFile() || scriptStat.isSymbolicLink() || realpathSync(script).toLowerCase() !== resolve(script).toLowerCase()) throw new Error('host preflight path is unsafe');
    const output = execFileSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-File',script],{
      cwd: reviewedSourceRoot, env: minimalEnvironment(), encoding: 'utf8', timeout: 5000, maxBuffer: 16384, windowsHide: true
    });
    const lines = output.split(/\r?\n/).filter(line => line.startsWith('QB_BUILD_HOST:'));
    if (lines.length !== 1) throw new Error('host preflight response is missing or ambiguous');
    const result = JSON.parse(lines[0]!.slice('QB_BUILD_HOST:'.length)) as Record<string,unknown>;
    if (result.version !== profile.version || result.effectivePolicy !== profile.policy ||
        result.machinePolicy !== 'Undefined' || result.userPolicy !== 'Undefined' || result.processPolicy !== 'Undefined' ||
        result.currentUserPolicy !== 'Undefined' || result.localMachinePolicy !== profile.policy)
      throw new Error('host version or execution policy does not match the selected profile');
    return profile;
  } catch {
    throw new Error('The private local PowerShell build-host profile failed its executable or ordinary policy preflight');
  }
}
