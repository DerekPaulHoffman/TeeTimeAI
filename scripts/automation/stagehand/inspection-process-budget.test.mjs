import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryBrowser } from '../course-discovery-worker.mjs';

test('slow fixed inspection gets a bounded process budget without extending its caller deadline', async () => {
  for (const [fixedInspection, remaining, expectedMaximum] of [[false, 240000, 90000], [true, 240000, 180000], [true, 15000, 15000]]) {
    const deadlineAt = new Date(Date.now() + remaining).toISOString();
    let spawned, closed = 0;
    const browser = createDiscoveryBrowser({ cwd: process.cwd(), initialUrls: ['https://example.org/'], deadlineAt, fixedInspection,
      processFactory: options => { spawned = options; return { request: async () => ({}), close: async () => { closed++; } }; } });
    assert.ok(spawned.timeoutMs <= expectedMaximum && spawned.timeoutMs > expectedMaximum - 1000);
    assert.equal(spawned.args[spawned.args.indexOf('--deadline') + 1], deadlineAt);
    // The extra time does not grant the private frame capability.
    assert.equal(spawned.environment.COURSE_DISCOVERY_FIXED_INSPECTION, undefined);
    await browser.close();
    assert.equal(closed, 1);
  }
});
