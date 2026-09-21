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
