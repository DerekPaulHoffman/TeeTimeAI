/** Isolated browser checks for brand directions and every mock venue state. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { designs, scenarios, renderEmail } from './email-brand-directions.mjs';

const output = resolve(process.argv[2]);
const require = createRequire(resolve(process.argv[3] || '.', 'package.json'));
const { chromium } = require('@playwright/test');
const sharp = require('sharp');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 680, height: 1040 }, deviceScaleFactor: 1 });
const errors = [];
const network = [];
page.on('pageerror', error => errors.push(error.message));
await page.route(/^https?:/, route => { network.push(route.request().url()); return route.abort(); });
await mkdir(resolve(output, 'screenshots'), { recursive: true });
const assets = { course: pathToFileURL(resolve(output, 'assets/course.png')).href, sim: pathToFileURL(resolve(output, 'assets/simulator.webp')).href };
const results = [];
// A file-origin document may load the copied local photo assets. about:blank cannot.
await page.goto(pathToFileURL(resolve(output, 'emails/01-course-instant.html')).href);
for (const url of Object.values(assets)) {
  assert.ok(await page.evaluate(async src => { const img = new Image(); img.src = src; await img.decode(); return img.naturalWidth; }, url), 'Photo asset must load');
}

async function check(design, mode, scenario, width, kind = 'morning', stress = false) {
  await page.setViewportSize({ width, height: 1040 });
  await page.setContent(renderEmail(design, { mode, scenario, kind, stress }, assets));
  const got = await page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    text: document.body.innerText,
    cards: document.querySelectorAll('[data-course-card]').length,
    newTimes: document.querySelectorAll('[data-time="new"]').length,
    existingTimes: document.querySelectorAll('[data-time="existing"]').length,
    clipped: [...document.querySelectorAll('a')].filter(a => a.scrollWidth > a.clientWidth + 1).map(a => a.textContent),
    small: [...document.querySelectorAll('a')].filter(a => a.getBoundingClientRect().height < 43).map(a => a.textContent),
    headers: [...document.querySelectorAll('[data-course-card] td[style*="background-image"]')].length,
    newColors: [...document.querySelectorAll('[data-time="new"]')].map(el => getComputedStyle(el).backgroundColor),
    oldColors: [...document.querySelectorAll('[data-time="existing"]')].map(el => getComputedStyle(el).backgroundColor),
    stateStyles: [...document.querySelectorAll('[data-status]')].map(el => el.getAttribute('data-state-style')),
    panels: [...document.querySelectorAll('[data-status]')].map(el => ({ state: el.dataset.status, followUp: el.dataset.followUp, text: el.innerText }))
  }));
  const key = `${design.id}/${mode}/${scenario}/${kind}/${stress}/${width}`;
  assert.ok(got.width <= width + 1, `${key}: overflow ${got.width}`);
  assert.deepEqual(got.clipped, [], `${key}: clipped links`);
  assert.deepEqual(got.small, [], `${key}: short link targets`);
  assert.equal(got.cards, scenario === 'mixed' ? 5 : 1, key);
  assert.ok(got.headers >= got.cards, `${key}: missing photo headers`);
  assert.match(got.text, /Tee Time Spot/);
  assert.match(got.text, /EDT/);
  assert.match(got.text, /Manage this alert/);
  assert.match(got.text, /Cancel this alert/);
  assert.match(got.text, /You book direct/);
  assert.doesNotMatch(got.text, /priority|ranked|ranking/i, key);
  assert.equal(got.stateStyles.length, scenario === 'mixed' ? 4 : scenario === 'new' ? 0 : 1, key);
  assert.ok(got.stateStyles.every(style => style === 'selected-photo-card'), key);
  for (const panel of got.panels) {
    const needsUser = ['review', 'direct', 'phone', 'account', 'captcha', 'invalid'].includes(panel.state);
    assert.equal(panel.followUp, needsUser ? 'user' : 'automatic', key);
    assert.match(panel.text, needsUser ? /Your next step/ : /What we’ll do next/, key);
    if (needsUser) assert.doesNotMatch(panel.text, /No action needed|try again automatically|WE’RE WORKING ON IT/, key);
    if (['none', 'checking', 'existing', 'window', 'recovered', 'gone', 'outside'].includes(panel.state)) assert.match(panel.text, /No action needed/, key);
  }
  if (mode === 'sim') {
    assert.match(got.text, /simulator|SIMULATOR/);
    assert.match(got.text, /60.minute|60 min/i);
    assert.doesNotMatch(got.text, /holes|green fee|golfers|layout/i);
  }
  assert.equal(got.newTimes, ['mixed', 'new'].includes(scenario) ? 2 : 0, key);
  assert.equal(got.existingTimes, ['mixed', 'existing', 'recovered'].includes(scenario) ? mode === 'sim' && stress ? 8 : 4 : 0, key);
  assert.ok(got.newColors.every(color => color === 'rgb(20, 35, 29)'), key);
  assert.ok(got.oldColors.every(color => color === 'rgb(234, 243, 238)'), key);
  if (got.newTimes) assert.match(got.text, /New since your last email|newly found/);
  if (got.existingTimes) assert.match(got.text, /previously shared/i);
  if (scenario === 'existing') assert.match(got.text, /no new matches this time/);
  if (scenario === 'none') assert.match(got.text, /found no .*matching your saved request/);
  if (scenario === 'checking') assert.match(got.text, /haven’t confirmed any openings/);
  if (scenario === 'window') assert.match(got.text, /Wed, Oct 28 at 7:00 AM EDT/);
  if (scenario === 'retry') { assert.match(got.text, /can’t confirm which openings/); assert.match(got.text, /try again automatically/); }
  if (scenario === 'support') assert.match(got.text, /can’t confirm openings here yet/);
  if (scenario === 'review') { assert.match(got.text, /needs a closer look/); assert.doesNotMatch(got.text, /our team reviews|WE’RE WORKING ON IT|try again automatically/); }
  if (scenario === 'direct') assert.match(got.text, /can’t check.*automatically/);
  if (scenario === 'account') assert.match(got.text, /can’t check pages that require your account/);
  if (scenario === 'captcha') assert.match(got.text, /complete its verification.*yourself/);
  if (scenario === 'invalid') assert.match(got.text, mode === 'sim' ? /does not offer public simulator rentals/ : /course is private/);
  if (scenario === 'stale') assert.match(got.text, /keeping them out of your current results/);
  if (scenario === 'gone') assert.match(got.text, /NO LONGER AVAILABLE · NOT A CURRENT MATCH/);
  if (scenario === 'outside') assert.match(got.text, /none matching your request/);
  results.push({ design: design.id, mode, scenario, width, kind, stress });
}

try {
  for (const d of designs) {
    for (const mode of ['course', 'sim']) for (const s of scenarios) for (const width of [320, 375, 680]) await check(d, mode, s.id, width);
    for (const mode of ['course', 'sim']) for (const width of [320, 375]) await check(d, mode, 'mixed', width, 'morning', true);
    for (const mode of ['course', 'sim']) {
      await page.setViewportSize({ width: 680, height: 1040 });
      await page.setContent(renderEmail(d, { mode, scenario: 'mixed' }, assets));
      await page.screenshot({ path: resolve(output, `screenshots/${String(d.id).padStart(2, '0')}-${mode}.png`) });
    }
    console.log(`Direction ${String(d.id).padStart(2, '0')}: all ${scenarios.length} states, both modes, narrow/phone/desktop + stress passed.`);
  }
  for (const mode of ['course', 'sim']) for (const s of scenarios) for (const width of [414, 768, 1024]) await check(designs[19], mode, s.id, width);
  for (const kind of ['setup', 'morning', 'instant']) for (const mode of ['course', 'sim']) for (const scenario of ['mixed', 'new', 'existing', 'checking', 'retry']) await check(designs[19], mode, scenario, 375, kind);
  // Render actual individual state cards for the side-by-side state board.
  for (const mode of ['course', 'sim']) for (const s of scenarios) {
    await page.setViewportSize({ width: 680, height: 1040 });
    await page.setContent(renderEmail(designs[19], { mode, scenario: s.id, kind: 'morning' }, assets));
    await page.locator('[data-course-card]').first().screenshot({ path: resolve(output, `states/${mode}-${s.id}.png`) });
  }
  // Images disabled: identity, state, times and action text still exist.
  for (const mode of ['course', 'sim']) {
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.setContent(renderEmail(designs[19], { mode, scenario: 'mixed' }, { course: '', sim: '' }));
    await page.addStyleTag({ content: '[style*="background-image"]{background-image:none!important}' });
    assert.equal(await page.locator('[data-time="new"]').count(), 2);
    assert.match(await page.locator('body').innerText(), /previously shared/);
    await page.screenshot({ path: resolve(output, `screenshots/20-${mode}-images-off.png`) });
  }
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(pathToFileURL(resolve(output, 'index.html')).href);
  await page.locator('#name').waitFor();
  assert.equal(await page.locator('.design').count(), 20);
  assert.equal(await page.locator('#scenario option').count(), scenarios.length);
  await page.locator('#next').click();
  assert.equal(await page.locator('#name').innerText(), 'New openings spotlight');
  for (const s of scenarios) {
    await page.locator('#scenario').selectOption(s.id);
    await page.frameLocator('#desktop').locator(`[data-course-card="${s.id}"]`).first().waitFor();
    assert.equal(await page.frameLocator('#desktop').locator('[data-course-card]').count(), s.id === 'mixed' ? 5 : 1);
  }
  assert.equal(await page.locator('#kind').inputValue(), 'morning');
  await page.locator('#scenario').selectOption('new');
  await page.locator('#kind').selectOption('instant');
  await page.locator('#size').selectOption('320');
  assert.equal(await page.frameLocator('#desktop').locator('html').evaluate(() => innerWidth), 320);
  await page.frameLocator('#desktop').getByRole('link', { name: 'View openings on the official site', exact: false }).first().click();
  assert.match(await page.locator('#toast').innerText(), /no booking, cancellation or email action was taken/);
  await page.locator('.design[data-id="20"]').click();
  await page.locator('#scenario').selectOption('mixed');
  await page.locator('#mode').selectOption('course');
  await page.locator('#size').selectOption('680');
  for (const width of [320, 375, 768, 1024, 1600]) {
    await page.setViewportSize({ width, height: 1100 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `gallery overflow at ${width}`);
  }
  await page.screenshot({ path: resolve(output, 'gallery.png') });
  await page.goto(pathToFileURL(resolve(output, 'states.html')).href);
  await page.locator('#state').selectOption('retry');
  assert.equal(await page.locator('.state:visible').count(), 1);
  await page.locator('#mode').selectOption('sim');
  assert.equal(await page.locator('[data-mode="course"]:visible').count(), 0);
  assert.equal(await page.locator('[data-mode="sim"]:visible').count(), 1);
  await page.screenshot({ path: resolve(output, 'state-playground.png') });
  assert.deepEqual(errors, [], 'Browser errors');
  assert.deepEqual(network, [], 'Unexpected external network calls');
  const tiles = [];
  for (const d of designs) {
    const shot = await sharp(await readFile(resolve(output, `screenshots/${String(d.id).padStart(2, '0')}-course.png`))).resize(320, 490).toBuffer();
    const label = Buffer.from(`<svg width="320" height="56"><rect width="320" height="56" fill="#f4efe5"/><text x="0" y="24" font-family="Arial" font-size="15" font-weight="700" fill="#14231d">${String(d.id).padStart(2, '0')} / ${d.name.replace(/&/g, '&amp;')}</text><text x="0" y="45" font-family="Arial" font-size="11" fill="#5c6c64">${d.bestFor}</text></svg>`);
    const x = ((d.id - 1) % 4) * 344 + 24, y = Math.floor((d.id - 1) / 4) * 574 + 100;
    tiles.push({ input: shot, left: x, top: y }, { input: label, left: x, top: y + 492 });
  }
  const title = Buffer.from('<svg width="1392" height="80"><text x="24" y="37" font-family="Arial" font-size="28" font-weight="700" fill="#14231d">Tee Time Spot / Selected photo-card style</text><text x="24" y="64" font-family="Arial" font-size="13" fill="#5c6c64">20 brand-faithful layouts · photo headers · orange NEW · previously shared times in green · 18 state scenarios</text></svg>');
  await sharp({ create: { width: 1392, height: 2980, channels: 3, background: '#f4efe5' } }).composite([{ input: title, top: 0, left: 0 }, ...tiles]).png().toFile(resolve(output, 'all-20-designs.png'));
  await writeFile(resolve(output, 'verification.json'), JSON.stringify({ revision: 4, generatedAt: new Date().toISOString(), checks: results.length, scenarios, browser: await browser.version(), errors, unexpectedNetworkCalls: network, scope: 'Offline mocks only; runtime templates and delivery unchanged', limitations: ['Native email clients and native dark-mode conversion not tested'], results }, null, 2));
  console.log(`PASS: ${results.length} render combinations; ${scenarios.length * 2} state-card screenshots; gallery and state-board interactions; images-off samples.`);
} finally { await browser.close(); }
