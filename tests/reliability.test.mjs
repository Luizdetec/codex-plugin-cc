import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeCodex, buildEnv } from './fake-codex-fixture.mjs';
import { loadState, resolveJobFile, upsertJob, writeJobFile } from '../plugins/codex/scripts/lib/state.mjs';
import { loadBrokerSession, sendBrokerShutdown } from '../plugins/codex/scripts/lib/broker-lifecycle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'plugins/codex/scripts/codex-companion.mjs');
const stateModule = new URL('../plugins/codex/scripts/lib/state.mjs', import.meta.url).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 15000, ...options });
}
function fixture(behavior = 'review-ok') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-audit-'));
  const bin = path.join(repo, 'bin');
  fs.mkdirSync(bin);
  installFakeCodex(bin, behavior);
  const env = { ...buildEnv(bin), CODEX_COMPANION_SESSION_ID: 'audit' };
  delete env.CODEX_COMPANION_APP_SERVER_ENDPOINT;
  return { repo, bin, env, invoke: (...args) => runNode([script, ...args], { cwd: repo, env }) };
}
async function cleanup(f) {
  const broker = loadBrokerSession(f.repo);
  if (broker) {
    await sendBrokerShutdown(broker.endpoint);
    for (let i = 0; i < 100; i++) {
      try { process.kill(broker.pid, 0); } catch { return; }
      await delay(25);
    }
    throw new Error(`Probe broker ${broker.pid} remained alive`);
  }
}

test('concurrent state updates preserve both jobs and payloads', async () => {
  const f = fixture();
  const ready = path.join(f.repo, 'ready');
  const release = path.join(f.repo, 'release');
  const code = `import fs from 'node:fs'; import {updateState} from ${JSON.stringify(stateModule)};
    updateState(process.cwd(), state => {
      state.jobs.push({id:'job-a',status:'running'});
      fs.writeFileSync('ready','');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: f.repo, stdio: 'ignore' });
  const ended = new Promise(resolve => child.once('exit', resolve));
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await delay(20);
    assert.ok(fs.existsSync(ready));
    writeJobFile(f.repo, 'job-b', { id: 'job-b', status: 'running', request: { prompt: 'test' } });
    upsertJob(f.repo, { id: 'job-b', status: 'running' });
    fs.writeFileSync(release, '');
    assert.equal(await ended, 0);
    assert.deepEqual(loadState(f.repo).jobs.map(job => job.id).sort(), ['job-a', 'job-b']);
    assert.equal(fs.existsSync(resolveJobFile(f.repo, 'job-b')), true);
  } finally {
    fs.writeFileSync(release, '');
    await ended;
  }
});

test('background launch survives a descheduled launcher', async () => {
  const f = fixture();
  const preload = new URL('./fixtures/launch-delay.mjs', import.meta.url).href;
  try {
    const result = runNode(['--import', preload, script, 'task', '--background', '--json', 'inspect'], { cwd: f.repo, env: f.env });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    await delay(300);
    let job;
    for(let i=0;i<100;i++){job=loadState(f.repo).jobs.find(job=>job.id===receipt.jobId);if(job.status==='completed')break;await delay(50);}
    assert.equal(job.status, 'completed');
    assert.equal(job.pid, null);
    assert.ok(JSON.parse(fs.readFileSync(path.join(f.bin, 'fake-codex-state.json'))).lastTurnStart);
  } finally { await cleanup(f); }
});

test('setup recovers read-only diagnosis after a broker crash', async () => {
  const f = fixture('crash-task');
  try {
    const failed = f.invoke('task', 'inspect');
    assert.notEqual(failed.status, 0);
    const setup = f.invoke('setup', '--json');
    assert.equal(setup.status, 0, setup.stderr);
    const report = JSON.parse(setup.stdout);
    assert.equal(report.ready, true);
    assert.equal(report.auth.loggedIn, true);
    assert.doesNotMatch(report.auth.detail, /ENOENT|ECONNREFUSED/);
    const directModels = f.invoke('models', '--json');
    assert.equal(directModels.status, 0, directModels.stderr);
  } finally { await cleanup(f); }
});

test('terminal turn.error survives JSON and stored result rendering', async () => {
  const f = fixture();
  const binary = path.join(f.bin, 'codex');
  let source = fs.readFileSync(binary, 'utf8');
  const success = 'send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });';
  assert.ok(source.includes(success));
  source = source.replace(success, 'send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "failed", {message:"AUDIT_TERMINAL_ERROR"}) } });');
  fs.writeFileSync(binary, source);
  try {
    const task = f.invoke('task', '--json', 'inspect');
    assert.equal(task.status, 1, task.stderr);
    assert.equal(JSON.parse(task.stdout).status, 1);
    assert.equal(task.stdout.includes('AUDIT_TERMINAL_ERROR'), true);
    const result = f.invoke('result');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('AUDIT_TERMINAL_ERROR'), true);
    assert.match(result.stdout, /failed/i);
  } finally { await cleanup(f); }
});

test('delayed terminal failure cannot be promoted to success', async () => {
  const f = fixture();
  const binary = path.join(f.bin, 'codex');
  const terminalMarker = path.join(f.repo, 'terminal-emitted');
  const success = 'send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });';
  const source = fs.readFileSync(binary, 'utf8');
  assert.ok(source.includes(success));
  fs.writeFileSync(binary, source.replace(success,
    `setTimeout(() => { fs.writeFileSync(${JSON.stringify(terminalMarker)}, 'yes'); send({method:'turn/completed', params:{threadId, turn:buildTurn(turnId,'failed',{message:'DELAYED_FAILURE'})}}); }, 1200);`));
  try {
    const result = f.invoke('task', '--json', 'inspect');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 1);
    await delay(1300);
    assert.equal(fs.existsSync(terminalMarker), true);
  } finally { await cleanup(f); }
});

test('cancellation before turn/start releases the write lock', async () => {
  const f = fixture();
  const binary = path.join(f.bin, 'codex');
  const marker = path.join(f.repo, 'catalog-entered');
  const source = fs.readFileSync(binary, 'utf8');
  fs.writeFileSync(binary, source.replace('case "model/list": {',
    `case "model/list": { fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);`));
  const key = createHash('sha256').update(fs.realpathSync(f.repo)).digest('hex');
  const lock = path.join(os.tmpdir(), 'codex-astra-write-locks', key);
  let workerPid;
  try {
    const result = f.invoke('task', '--write', '--background', '--json', 'inspect');
    assert.equal(result.status, 0, result.stderr);
    const jobId = JSON.parse(result.stdout).jobId;
    for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await delay(20);
    assert.ok(fs.existsSync(marker));
    workerPid = loadState(f.repo).jobs.find(job => job.id === jobId).pid;
    const cancelled = f.invoke('cancel', jobId, '--json');
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).turnInterruptAttempted, false);
    for (let i = 0; i < 100; i++) {
      try { process.kill(workerPid, 0); } catch { break; }
      await delay(20);
    }
    assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
    const retry = f.invoke('task', '--write', 'inspect again');
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    await cleanup(f);
    if (workerPid) assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
    if (fs.existsSync(lock)) {
      fs.rmSync(path.join(lock, 'owner.json'), { force: true });
      fs.rmdirSync(lock);
    }
  }
});
