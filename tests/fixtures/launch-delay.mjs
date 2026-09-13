import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Fault injection: simulate the launcher being descheduled after creating its worker.
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  const child = originalSpawn.call(this, command, args, options);
  if (args?.includes('task-worker')) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  }
  return child;
};
syncBuiltinESMExports();
