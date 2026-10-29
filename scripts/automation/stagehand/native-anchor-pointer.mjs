import { chromium } from '@playwright/test';

/** Input transport only. The source controller's native witness and unchanged
 * request guard retain authority; this attaches only to its launch-owned CDP. */
export async function createNativeAnchorPointer({ cdpUrl, deadline, assertGuardedTargets },
  { connect = (url, options) => chromium.connectOverCDP(url, options) } = {}) {
  if (!/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/devtools\/browser\/[a-f0-9-]{20,80}$/u.test(cdpUrl ?? '') ||
      !Number.isFinite(deadline) || deadline <= Date.now() || typeof assertGuardedTargets !== 'function')
    throw Error('STAGEHAND_NATIVE_POINTER_SCOPE_INVALID');
  const browser = await connect(cdpUrl, { timeout: Math.min(10000, deadline - Date.now()) });
  let closed = false;
  return {
    async click({ targetId, selector, sourceUrl, evidence, readTarget }) {
      if (closed || Date.now() >= deadline || !/^[A-Za-z0-9_-]{1,200}$/u.test(targetId ?? '') ||
          typeof selector !== 'string' || selector.length > 1000 || typeof readTarget !== 'function' ||
          !await assertGuardedTargets([targetId])) throw Error('STAGEHAND_NATIVE_POINTER_SCOPE_INVALID');
      const pages = browser.contexts().flatMap(context => context.pages());
      if (pages.length > 16) throw Error('STAGEHAND_NATIVE_POINTER_SCOPE_INVALID');
      let selected;
      for (const page of pages) {
        const cdp = await page.context().newCDPSession(page);
        try {
          const result = await cdp.send('Target.getTargetInfo');
          if (result.targetInfo?.targetId === targetId) selected = page;
        } finally { await cdp.detach(); }
      }
      if (!selected || selected.url() !== sourceUrl || Date.now() >= deadline)
        throw Error('ACTION_TARGET_REJECTED');
      const fresh = await selected.evaluate(readTarget, selector);
      if (selected.url() !== sourceUrl || JSON.stringify(fresh) !== JSON.stringify(evidence) ||
          !await assertGuardedTargets([targetId]) || Date.now() >= deadline) throw Error('ACTION_TARGET_REJECTED');
      await selected.locator(selector).click({ timeout: Math.min(4000, Math.max(1, deadline - Date.now())) });
    },
    async close() {
      if (closed) return;
      closed = true;
      // The SDK and guardian normally close this same owned browser first.
      // A remaining connection may close only that launch-owned Chrome.
      if (browser.isConnected()) await browser.close();
    },
  };
}
