// Start Azurite first, then RUN_AZURITE_TESTS=1 npm test. Never connects to Azure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { QueueClient } from '@azure/storage-queue';
import { AzureStore } from '../store';
test(
  'Azure Tables persist across clients and reject concurrent stale writes; queues round-trip job IDs',
  { skip: process.env['RUN_AZURITE_TESTS'] !== '1' },
  async () => {
    const connection = 'UseDevelopmentStorage=true';
    const first = new AzureStore(connection),
      second = new AzureStore(connection);
    await first.initialize();
    await second.initialize();
    const id = randomUUID(),
      value = { id, expires: Date.now() + 60000, count: 1 };
    assert.equal(await first.create('integration', value), true);
    assert.equal(await second.create('integration', value), false);
    const row = (await second.get<typeof value>('integration', id))!;
    assert.equal(row.value.count, 1);
    const results = await Promise.all([
      first.replace('integration', { ...value, count: 2 }, row.etag),
      second.replace('integration', { ...value, count: 3 }, row.etag),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    const saved = (await first.get<typeof value>('integration', id))!;
    assert([2, 3].includes(saved.value.count));
    await first.remove('integration', id, saved.etag);
    assert.equal(await second.get('integration', id), null);
    const queue = new QueueClient(connection, 'integration-' + id.toLowerCase());
    await queue.create();
    try {
      await queue.sendMessage(Buffer.from(id).toString('base64'));
      const result = await queue.receiveMessages();
      assert.equal(
        Buffer.from(result.receivedMessageItems[0].messageText, 'base64').toString(),
        id,
      );
    } finally {
      await queue.delete();
    }
  },
);

test(
  'large forecast records survive create, list and replacements across Azure clients',
  { skip: process.env['RUN_AZURITE_TESTS'] !== '1' },
  async () => {
    const connection = 'UseDevelopmentStorage=true';
    const first = new AzureStore(connection);
    const second = new AzureStore(connection);
    await first.initialize();
    const id = randomUUID();
    // Azurite corrupts multibyte text on large PUT requests; codec tests cover Unicode.
    const large = { id, forecast: 'clear '.repeat(18000) };
    try {
      assert.equal(await first.create('integration', large), true);
      let row = (await second.get<typeof large>('integration', id))!;
      assert.deepEqual(row.value, large);
      const listed = [];
      for await (const item of second.list<typeof large>('integration')) {
        if (item.value.id === id) listed.push(item.value);
      }
      assert.deepEqual(listed, [large]);

      const small = { id, forecast: 'updated' };
      assert.equal(await first.replace('integration', small, row.etag), true);
      assert.equal(await second.replace('integration', large, row.etag), false);
      row = (await second.get<typeof large>('integration', id))!;
      assert.deepEqual(row.value, small);

      assert.equal(await first.replace('integration', large, row.etag), true);
      assert.deepEqual((await second.get<typeof large>('integration', id))!.value, large);
    } finally {
      const row = await first.get<typeof large>('integration', id);
      if (row) await first.remove('integration', id, row.etag);
    }
  },
);
