import { spawn } from 'node:child_process';

// Zero-dependency dev/prod entrypoint: runs the API (server.js) and the
// BullMQ worker (workers/worker.js) as sibling processes in one terminal.
// Jobs enqueued by the webhook are only ever processed if the worker process
// is alive, so starting them together removes the "messages enqueued but never
// answered" failure mode. `--watch` applies node --watch to both children so
// edits restart whichever side changed.
//
// Exit policy: if either child dies, the sibling is torn down and we exit
// non-zero. A dead worker must be loud, not a silent queue black hole.

const watch = process.argv.includes('--watch');

const targets = [
  { name: 'api', file: 'server.js' },
  { name: 'worker', file: 'workers/worker.js' },
];

const children = targets.map(({ name, file }) => {
  const args = watch ? ['--watch', file] : [file];
  const child = spawn(process.execPath, args, {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: process.env,
    windowsHide: false,
  });
  child.on('exit', (code, signal) => {
    if (code !== 0) {
      console.error(`[start-all] ${name} (${file}) exited with code ${code} (signal ${signal})`);
    }
    teardown(code === 0 ? 0 : 1, `${name} exited`);
  });
  child.on('error', (err) => {
    console.error(`[start-all] failed to start ${name}: ${err.message}`);
    teardown(1, `${name} failed to start`);
  });
  return child;
});

let stopping = false;
function teardown(code, reason) {
  if (stopping) return;
  stopping = true;
  console.error(`[start-all] shutting down: ${reason}`);
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  // Give the children a moment to exit gracefully, then force-exit so this
  // parent never lingers as a zombie.
  setTimeout(() => process.exit(code), 1000).unref();
}

const handleSignal = (signal) => {
  console.log(`[start-all] ${signal} received, forwarding to children`);
  teardown(0, signal);
};

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));
