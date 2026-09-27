// @ts-check
// End-to-end tests of the web remote (Web/) against a mock of the iPhone app's API.
const { test, expect } = require('@playwright/test');

/** Resets the mock iPhone, optionally overriding parts of its camera state. */
async function resetPhone(request, state = {}) {
  await request.post('/__reset', { data: state });
}

async function sentLog(request) {
  return (await request.get('/__log')).json();
}

/** Waits until the remote has sent a settings request matching `predicate`. */
async function expectSettings(request, predicate) {
  await expect
    .poll(async () => (await sentLog(request)).some((e) => e.settings && predicate(e.settings)), { timeout: 5000 })
    .toBe(true);
}

async function openRemote(page) {
  await page.goto('/');
  await expect(page.locator('#conn')).toHaveText('iPhone connected');
  await expect.poll(() => page.locator('#preview').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
}

test.beforeEach(async ({ request }) => {
  await resetPhone(request);
});

test.describe('connection and preview', () => {
  test('connects to the phone and shows the live preview', async ({ page }) => {
    await openRemote(page);
    await expect(page.locator('#placeholder')).toBeHidden();
    await expect(page.locator('#shootBtn')).toBeEnabled();
    await expect(page.locator('#readout')).toContainText('Wide 1×');
    await expect(page.locator('#readout')).toContainText('ISO 320');
    await expect(page.locator('#device')).toContainText('83%');
  });

  test('shows that the phone is unreachable and recovers', async ({ page, request }) => {
    await openRemote(page);
    await request.post('/__offline', { data: { offline: true } });
    await expect(page.locator('#conn')).toHaveText('iPhone not reachable');
    await expect(page.locator('#shootBtn')).toBeDisabled();
    await request.post('/__offline', { data: { offline: false } });
    await expect(page.locator('#conn')).toHaveText('iPhone connected');
  });

  test('draws a histogram of the preview', async ({ page }) => {
    await openRemote(page);
    await expect
      .poll(() =>
        page.locator('#histogram').evaluate((c) => {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let lit = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
          return lit;
        })
      )
      .toBeGreaterThan(500);
  });
});

test.describe('lenses and zoom', () => {
  test('lists lenses from widest to longest and switches lens', async ({ page, request }) => {
    await openRemote(page);
    await expect(page.locator('#lenses button')).toHaveText(['0.5×', '1×', '5×']);
    await expect(page.locator('#lenses button.on')).toHaveText('1×');
    await page.locator('#lenses button[data-v=tele]').click();
    await expectSettings(request, (s) => s.lens === 'tele');
    await expect(page.locator('#lenses button.on')).toHaveText('5×');
    await expect(page.locator('#readout')).toContainText('Telephoto 5×');
  });

  test('shows a single lens on one-camera iPhones', async ({ page, request }) => {
    await resetPhone(request, { lenses: [{ id: 'wide', name: 'Wide', factor: 1 }] });
    await openRemote(page);
    await expect(page.locator('#lenses button')).toHaveText(['1×']);
  });
});

test.describe('exposure', () => {
  test('ISO and shutter are visible in auto mode with a hint', async ({ page }) => {
    await openRemote(page);
    await expect(page.locator('#expMode button.on')).toHaveText('Auto');
    await expect(page.locator('#iso')).toBeVisible();
    await expect(page.locator('#shutter')).toBeVisible();
    await expect(page.locator('[data-show=exp-auto]')).toBeVisible();
    await expect(page.locator('#isoOut')).toHaveText('320');
    await expect(page.locator('#shutterOut')).toHaveText('1/60');
  });

  test('only offers ISO and shutter presets the camera supports', async ({ page }) => {
    await openRemote(page);
    await expect(page.locator('#isoChips button')).toHaveText(['32', '50', '64', '100', '200', '400', '800', '1600']);
    await expect(page.locator('#shutterChips button').first()).toHaveText('1/8000');
    await expect(page.locator('#shutterChips button').last()).toHaveText('1.0 s');
  });

  test('picking an ISO switches to manual exposure', async ({ page, request }) => {
    await openRemote(page);
    await page.locator('#isoChips button', { hasText: /^100$/ }).click();
    await expectSettings(request, (s) => s.iso === 100);
    await expect(page.locator('#expMode button.on')).toHaveText('Manual');
    await expect(page.locator('[data-show=exp-auto]')).toBeHidden();
    await expect(page.locator('#isoOut')).toHaveText('100');
  });

  test('picking a shutter speed switches to manual exposure', async ({ page, request }) => {
    await openRemote(page);
    await page.locator('#shutterChips button', { hasText: '1/500' }).click();
    await expectSettings(request, (s) => Math.abs(s.shutter - 1 / 500) < 1e-9);
    await expect(page.locator('#shutterOut')).toHaveText('1/500');
    await expect(page.locator('#readout')).toContainText('1/500');
  });

  test('the ISO slider uses a logarithmic scale', async ({ page, request }) => {
    await openRemote(page);
    // The middle of a log scale between 32 and 3072 is their geometric mean (~314).
    await page.locator('#iso').evaluate((el) => {
      el.value = '500';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expectSettings(request, (s) => s.iso > 300 && s.iso < 330);
  });

  test('switching back to auto sends exposureMode', async ({ page, request }) => {
    await resetPhone(request, { exposureMode: 'manual' });
    await openRemote(page);
    await page.locator('#expMode button', { hasText: 'Auto' }).click();
    await expectSettings(request, (s) => s.exposureMode === 'auto');
  });
});

test.describe('focus', () => {
  test('bracket keys nudge the lens position', async ({ page, request }) => {
    await openRemote(page);
    await page.keyboard.press('BracketRight');
    await expectSettings(request, (s) => Math.abs(s.lensPosition - 0.602) < 1e-6);
    await page.keyboard.press('Shift+BracketLeft');
    await expectSettings(request, (s) => Math.abs(s.lensPosition - 0.592) < 1e-6);
    await expect(page.locator('#focusMode button.on')).toHaveText('Manual');
  });

  test('∞ moves the lens to the far end', async ({ page, request }) => {
    await openRemote(page);
    await page.locator('#focusInf').click();
    await expectSettings(request, (s) => s.lensPosition === 1);
  });

  test('manual focus is disabled on cameras without it', async ({ page, request }) => {
    await resetPhone(request, { manualFocusSupported: false });
    await openRemote(page);
    await expect(page.locator('#focusMode button', { hasText: 'Manual' })).toBeDisabled();
  });

  test('L cycles the loupe 1× → 2× → 4× → 8× → 1×', async ({ page, request }) => {
    await openRemote(page);
    await page.keyboard.press('KeyL');
    await expectSettings(request, (s) => s.loupe === 2);
    await expect(page.locator('#loupeBadge')).toHaveText('Loupe 2×');
    for (const v of [4, 8, 1]) {
      await page.keyboard.press('KeyL');
      await expect(page.locator('#loupe button.on')).toHaveText(`${v}×`);
    }
    // Quick presses are batched into one request; the phone ends up at the last value.
    await expectSettings(request, (s) => s.loupe === 1);
    await expect(page.locator('#loupeBadge')).toBeHidden();
  });

  test('clicking the preview sets the focus point, corrected for the loupe', async ({ page, request }) => {
    await openRemote(page);
    const box = await page.locator('#preview').boundingBox();
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
    await expect(page.locator('.focus-mark')).toHaveCount(1);
    await expectSettings(request, (s) => s.point && Math.abs(s.point.x - 0.25) < 0.01 && Math.abs(s.point.y - 0.75) < 0.01);

    await page.keyboard.press('KeyL'); // 2× loupe: the view shows the central half of the frame
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
    await expectSettings(request, (s) => s.point && Math.abs(s.point.x - 0.375) < 0.01 && Math.abs(s.point.y - 0.625) < 0.01);
  });
});

test.describe('white balance', () => {
  test('moving the temperature slider sends temperature and tint', async ({ page, request }) => {
    await openRemote(page);
    await page.locator('#temp').evaluate((el) => {
      el.value = '4000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expectSettings(request, (s) => s.temperature === 4000 && typeof s.tint === 'number');
    await expect(page.locator('#tempOut')).toHaveText('4000 K');
  });

  test('manual white balance is disabled on cameras without it', async ({ page, request }) => {
    await resetPhone(request, { manualWBSupported: false });
    await openRemote(page);
    await expect(page.locator('#wbMode button', { hasText: 'Manual' })).toBeDisabled();
  });
});

test.describe('moon preset', () => {
  test('selects the longest lens, manual exposure and RAW', async ({ page, request }) => {
    await openRemote(page);
    await page.locator('#moonPreset').click();
    await expectSettings(
      request,
      (s) => s.lens === 'tele' && s.exposureMode === 'manual' && s.iso === 50 && s.shutter === 1 / 250 && s.wbMode === 'manual'
    );
    await expect(page.locator('#format')).toHaveValue('raw');
    await expect(page.locator('#delay')).toHaveValue('2');
    await expect(page.locator('#toast')).toContainText('Aim at the Moon');
  });

  test('never goes below the minimum ISO of the camera', async ({ page, request }) => {
    await resetPhone(request, { minISO: 64 });
    await openRemote(page);
    await page.locator('#moonPreset').click();
    await expectSettings(request, (s) => s.iso === 64);
  });
});

test.describe('capture', () => {
  test('shoots a series with the chosen options and lists the photos', async ({ page, request }) => {
    await openRemote(page);
    await page.selectOption('#format', 'heif');
    await page.selectOption('#resolution', '12mp');
    await page.selectOption('#delay', '0');
    await page.fill('#count', '3');
    await page.fill('#interval', '0.2');
    await page.locator('#saveToPhotos').check();
    await page.locator('#shootBtn').click();

    await expect(page.locator('#seriesBadge')).toContainText('Series');
    await expect(page.locator('#cancelBtn')).toBeVisible();
    await expect(page.locator('.photo')).toHaveCount(3);
    await expect(page.locator('#photoCount')).toHaveText('(3)');
    await expect(page.locator('#seriesBadge')).toBeHidden();

    const capture = (await sentLog(request)).find((e) => e.capture).capture;
    expect(capture).toEqual({ format: 'heif', count: 3, interval: 0.2, delay: 0, saveToPhotos: true, resolution: '12mp' });
  });

  test('Space shoots and Escape cancels a series', async ({ page, request }) => {
    await openRemote(page);
    await page.selectOption('#delay', '10');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Space');
    await expect(page.locator('#countdown')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#seriesBadge')).toBeHidden();
    const log = await sentLog(request);
    expect(log.some((e) => e.capture)).toBe(true);
    expect(log.some((e) => e.cancel)).toBe(true);
    await expect(page.locator('.photo')).toHaveCount(0);
  });

  test('shows the phone error when a capture is already running', async ({ page, request }) => {
    await openRemote(page);
    await request.post('/__state', { data: { capture: { busy: true, total: 5, done: 1, countdown: 0 } } });
    await expect(page.locator('#seriesBadge')).toHaveText('● Series 1/5');
    await request.post('/__state', { data: { capture: { busy: false, total: 5, done: 5, countdown: 0, lastError: 'RAW is not available for this lens' } } });
    await expect(page.locator('#toast')).toHaveText('RAW is not available for this lens');
  });

  test('remembers format and resolution between visits', async ({ page }) => {
    await openRemote(page);
    await page.selectOption('#format', 'jpeg');
    await page.selectOption('#resolution', '12mp');
    await page.selectOption('#delay', '0');
    await page.locator('#shootBtn').click();
    await expect(page.locator('.photo')).toHaveCount(1);
    await page.reload();
    await openRemote(page);
    await expect(page.locator('#format')).toHaveValue('jpeg');
    await expect(page.locator('#resolution')).toHaveValue('12mp');
  });
});

test.describe('formats and resolution per iPhone model', () => {
  test('offers only the formats the phone reports', async ({ page, request }) => {
    await resetPhone(request, { formats: ['jpeg', 'raw'] }); // e.g. iPhone 6s: no HEVC, no ProRAW
    await openRemote(page);
    await expect(page.locator('#format option')).toHaveText(['JPEG', 'RAW (DNG)']);
  });

  test('resolution option appears only on 48 MP cameras and not for RAW', async ({ page, request }) => {
    await openRemote(page);
    await page.selectOption('#format', 'heif');
    await expect(page.locator('#resolution')).toBeVisible();
    await expect(page.locator('#resolution option').first()).toHaveText('Maximum (8064×6048)');
    await page.selectOption('#format', 'raw');
    await expect(page.locator('#resolution')).toBeHidden();

    await resetPhone(request, { resolution: '4032×3024' });
    await page.reload();
    await openRemote(page);
    await page.selectOption('#format', 'heif');
    await expect(page.locator('#resolution')).toBeHidden();
  });
});

test.describe('gallery', () => {
  test('photos can be downloaded and deleted', async ({ page, request }) => {
    await openRemote(page);
    await page.selectOption('#format', 'jpeg');
    await page.selectOption('#delay', '0');
    await page.locator('#shootBtn').click();
    await expect(page.locator('.photo')).toHaveCount(1);

    const name = await page.locator('.photo .name').textContent();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.photo a[title=Download]').click()]);
    expect(download.suggestedFilename()).toBe(name);

    page.once('dialog', (d) => d.accept());
    await page.locator('.photo button[title="Delete from iPhone"]').click();
    await expect(page.locator('.photo')).toHaveCount(0);
    expect((await sentLog(request)).some((e) => e.delete === name)).toBe(true);
  });
});

test.describe('view options', () => {
  test('G toggles the grid, N the red night mode, H the histogram', async ({ page }) => {
    await openRemote(page);
    await page.keyboard.press('KeyG');
    await expect(page.locator('#gridOverlay')).toHaveClass(/show/);
    await page.keyboard.press('KeyN');
    await expect(page.locator('body')).toHaveClass(/night/);
    await page.keyboard.press('KeyH');
    await expect(page.locator('#histogram')).toBeHidden();
  });

  test('reports battery and overheating', async ({ page, request }) => {
    await resetPhone(request, { battery: 0.15, charging: true, thermal: 'serious' });
    await openRemote(page);
    await expect(page.locator('#device')).toContainText('15% ⚡');
    await expect(page.locator('#device')).toContainText('overheating');
  });
});
