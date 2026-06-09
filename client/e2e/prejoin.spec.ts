import { test, expect } from '@playwright/test';
import { openPage, closePage, sleep } from './helpers';

test('pre-join: device selectors + mic/camera toggles', async ({ browser }) => {
  const t = await openPage(browser);
  const { page } = t;
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.selectOption('#lang', 'it');
  await page.fill('#name', 'Alessandro');
  await page.fill('#room', 'pj' + Math.floor(Math.random() * 1e6));
  await page.click('#enter');
  await page.waitForSelector('#prejoin:not(.hidden)');
  await page.waitForFunction(() => {
    const v = document.getElementById('preview') as HTMLVideoElement | null;
    return !!(v && v.srcObject && v.videoWidth > 0);
  });

  // Device selectors are populated.
  expect(await page.$$eval('#cam-select option', (o) => o.length)).toBeGreaterThan(0);
  expect(await page.$$eval('#mic-select option', (o) => o.length)).toBeGreaterThan(0);

  // Toggle mic + camera off → tracks disabled + overlay shown.
  await page.click('#pre-mic');
  await page.click('#pre-cam');
  await sleep(300);
  const st = await page.evaluate(() => {
    const s = (document.getElementById('preview') as HTMLVideoElement).srcObject as MediaStream;
    return {
      audio: s.getAudioTracks()[0].enabled,
      video: s.getVideoTracks()[0].enabled,
      off: !(document.getElementById('preview-off') as HTMLElement).hidden,
      micDanger: document.getElementById('pre-mic')!.classList.contains('active-danger'),
      camDanger: document.getElementById('pre-cam')!.classList.contains('active-danger'),
    };
  });
  expect(st.audio).toBe(false);
  expect(st.video).toBe(false);
  expect(st.off).toBe(true);
  expect(st.micDanger && st.camDanger).toBeTruthy();

  // Re-enable, then change the (re-acquire) device to exercise that path.
  await page.click('#pre-mic');
  await page.click('#pre-cam');
  await sleep(200);

  // Back to home.
  await page.click('#back-btn');
  await page.waitForSelector('#home:not(.hidden)');

  await closePage(t);
});
