import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { CodexAppServerClient } from '../plugins/codex/scripts/lib/app-server.mjs';
import { createBrokerEndpoint, parseBrokerEndpoint } from '../plugins/codex/scripts/lib/broker-endpoint.mjs';

for (const reviewThreadId of ['root', 'detached']) {
  test(`early completion stays terminal after review/start response (${reviewThreadId})`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-order-'));
    const endpoint = createBrokerEndpoint(cwd);
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      const lines = readline.createInterface({ input: socket });
      lines.on('line', line => {
        const message = JSON.parse(line);
        if (message.id === undefined) return;
        const send = value => socket.write(`${JSON.stringify(value)}\n`);
        if (message.method === 'review/start') {
          send({ method: 'turn/completed', params: { threadId: reviewThreadId, turn: { id: 'turn', status: 'completed' } } });
          send({ id: message.id, result: { reviewThreadId, turn: { id: 'turn', status: 'inProgress' } } });
        } else send({ id: message.id, result: {} });
      });
    });
    let client;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(parseBrokerEndpoint(endpoint).path, resolve);
      });
      client = await CodexAppServerClient.connect(cwd, { brokerEndpoint: endpoint });
      await client.request('review/start', { threadId: 'root', target: { type: 'uncommittedChanges' } });
      assert.equal(client.streamThreadId, null, 'completed reviews must not be reactivated by a late start response');
    } finally {
      await client?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}
