import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { visibleInspectionFrames } from '../../../src/lib/course-discovery/fixed-inspection-frame-witness.ts';

test('production tsx serializes the self-contained iframe callback in real Playwright', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe src="https://public.example/html/widget" style="width:100px;height:50px"></iframe>');
    const rows = await page.locator('iframe[src]').evaluateAll(visibleInspectionFrames);
    assert.deepEqual(rows, [{ src: 'https://public.example/html/widget', visible: true,
      srcdoc: false, inForm: false, handler: false }]);
  } finally { await browser.close(); }
});
