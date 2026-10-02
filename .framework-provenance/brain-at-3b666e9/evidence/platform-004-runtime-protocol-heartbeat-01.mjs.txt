import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(import.meta.url);

if (process.argv[2] === '--heartbeat') {
  const heartbeatPath = process.argv[3];
  if (!heartbeatPath) throw new Error('A heartbeat marker path is required');
  let beat = 0;
  const writeHeartbeat = () => writeFileSync(heartbeatPath, JSON.stringify({ pid: process.pid, beat: ++beat }));
  writeHeartbeat();
  setInterval(writeHeartbeat, 40);
} else {
  const [startedPath, heartbeatPath] = process.argv.slice(2);
  if (!startedPath || !heartbeatPath) throw new Error('Started and heartbeat marker paths are required');
  writeFileSync(startedPath, JSON.stringify({ pid: process.pid, started: true }));
  spawn(process.execPath, [fixturePath, '--heartbeat', heartbeatPath], {
    stdio: 'ignore',
    windowsHide: true
  });
  await new Promise(() => {});
}
