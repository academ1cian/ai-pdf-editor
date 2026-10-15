import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
async function setup(page: import('@playwright/test').Page) {
  await page.route('**/api/config', (r) =>
    r.fulfill({
      json: {
        enabled: true,
        siteKey: 'mock-site',
        appLimitsEnabled: false,
        ownerRequired: true,
        ownerAuthenticated: true,
      },
    }),
  );
  await page.addInitScript(() => {
    let callback: ((token: string) => void) | undefined,
      count = 0;
    window.turnstile = {
      render: (_el, options) => {
        callback = options.callback as (token: string) => void;
        queueMicrotask(() => callback?.('token-' + ++count));
        return 'mock-widget';
      },
      reset: () => queueMicrotask(() => callback?.('token-' + ++count)),
      remove: () => {},
    };
  });
  await page.goto('/');
  await page.getByLabel('Upload PDF').setInputFiles(resolve('tests/fixtures/mixed-invoice.pdf'));
  await expect(page.getByRole('img', { name: 'PDF page 1' })).toBeVisible();
  await page
    .getByLabel('I agree to send the displayed document context to Groq for a proposal.', {
      exact: true,
    })
    .check();
}
async function request(page: import('@playwright/test').Page, text: string) {
  await page.locator('#instruction').fill(text);
  await page.getByRole('button', { name: /^(Preview changes|Update preview)$/ }).click();
  await expect(page.locator('#instruction')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Apply & Download', exact: true })).toBeEnabled();
}
async function capture(page: import('@playwright/test').Page, path: string) {
  const hash = await page.locator('[data-preview-sha256]').getAttribute('data-preview-sha256');
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Apply & Download', exact: true }).click();
  await (await event).saveAs(path);
  const bytes = readFileSync(path);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
  });
  try {
    const pdf = await task.promise;
    return (await (await pdf.getPage(1)).getTextContent()).items
      .map((i) => ('str' in i ? i.str : ''))
      .join(' ');
  } finally {
    await task.destroy();
  }
}
test('cloud consent never forces provider calls for supported local financial and conversational requests', async ({
  page,
}, info) => {
  await setup(page);
  let posts = 0;
  await page.route('**/api/plan', (r) => {
    posts++;
    return r.fulfill({ status: 500, json: { error: 'Local request must not go to provider' } });
  });
  await request(page, 'Поменяй мне rate и charge на тысячу, а final amount посчитай сам.');
  await request(page, 'И ещё замени INVOICE на charlie kirk.');
  await request(page, 'Нет, charge сделай 950, а итог пересчитай.');
  await page.getByRole('button', { name: 'Remove change 4', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply & Download', exact: true })).toBeEnabled();
  const text = await capture(page, info.outputPath('local-consent.pdf'));
  for (const value of ['1000.0000', '950.00', '$1,015.00', '65.00', 'INVOICE'])
    expect(text).toContain(value);
  expect(text).not.toContain('charlie kirk');
  expect(posts).toBe(0);
});
test('actual provider429 response handling retries after delay with fresh verification and one combined approval (mock provider)', async ({
  page,
}, info) => {
  await setup(page);
  const requests: { at: number; data: Record<string, unknown> }[] = [];
  await page.route('**/api/plan', (r) => {
    const data = r.request().postDataJSON();
    requests.push({ at: Date.now(), data });
    if (requests.length === 1)
      return r.fulfill({
        status: 429,
        headers: { 'Retry-After': '1' },
        json: {
          error: 'Groq provider requested a pause.',
          code: 'provider_rate_limit',
          retryAfter: 1,
        },
      });
    const b = data.blocks.find((b: { text: string }) => b.text === 'Status: pending');
    return r.fulfill({
      json: {
        edits: [
          {
            id: 'status',
            operation: 'replace',
            page: b.page,
            blockId: b.id,
            original: 'Status: pending',
            replacement: 'Status: reviewed',
            ambiguity: 'none',
            explanation: 'Requested status update.',
          },
        ],
        interpretation: 'Marked status reviewed.',
      },
    });
  });
  await request(page, 'Change rate and charges to 1000 and recalculate total');
  const before = await page.locator('[data-preview-sha256]').getAttribute('data-preview-sha256');
  await page.locator('#instruction').fill('Mark the status as reviewed.');
  await page.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(page.getByLabel('AI retry status')).toContainText('1-second delay');
  await expect(page.locator('[data-preview-sha256]')).toHaveAttribute(
    'data-preview-sha256',
    before!,
  );
  await expect(page.locator('#instruction')).toBeEnabled({ timeout: 15000 });
  await expect(page.getByLabel('Edited document preview')).toContainText('4 changes prepared');
  await expect(page.getByRole('button', { name: 'Apply & Download', exact: true })).toBeEnabled();
  const text = await capture(page, info.outputPath('retry.pdf'));
  for (const value of ['Status: reviewed', '1000.0000', '1000.00', '$1,065.00', '65.00'])
    expect(text).toContain(value);
  expect(requests).toHaveLength(2);
  expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(900);
  expect(requests[1].data.turnstileToken).not.toBe(requests[0].data.turnstileToken);
  expect(requests[1].data.requestId).not.toBe(requests[0].data.requestId);
  expect(requests[1].data.pending).toEqual(requests[0].data.pending);
});
test('cancelling provider429 retry preserves instruction and valid preview for immediate approval (mock provider)', async ({
  page,
}, info) => {
  await setup(page);
  let requests = 0;
  await page.route('**/api/plan', (r) => {
    requests++;
    return r.fulfill({
      status: 429,
      json: { error: 'Provider pause', code: 'provider_rate_limit', retryAfter: 120 },
    });
  });
  await request(page, 'Change rate and charges to 1000 and recalculate total');
  const before = await page.locator('[data-preview-sha256]').getAttribute('data-preview-sha256');
  await page.locator('#instruction').fill('Mark the status as reviewed.');
  await page.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(page.getByLabel('AI retry status')).toContainText('120-second delay');
  await page.getByRole('button', { name: 'Cancel AI request', exact: true }).click();
  await expect(page.locator('#instruction')).toHaveValue('Mark the status as reviewed.');
  await expect(page.getByRole('alert')).toContainText(
    'previous validated preview remains available',
  );
  await expect(page.locator('[data-preview-sha256]')).toHaveAttribute(
    'data-preview-sha256',
    before!,
  );
  await expect(page.getByRole('button', { name: 'Apply & Download', exact: true })).toBeEnabled();
  expect(await capture(page, info.outputPath('cancelled-retry.pdf'))).toContain('$1,065.00');
  expect(requests).toBe(1);
});
test('owner key UI sends only a verifiable signature and keeps local editing available (mock owner server)', async ({
  page,
}) => {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const privateJWK = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const challenge = 'invented-owner-challenge';
  let authenticated = false;
  await page.route('**/api/config', (r) =>
    r.fulfill({
      json: {
        enabled: true,
        appLimitsEnabled: false,
        ownerRequired: true,
        ownerAuthenticated: false,
      },
    }),
  );
  await page.route('**/api/owner/challenge', (r) => r.fulfill({ json: { challenge } }));
  await page.route('**/api/owner/session', async (r) => {
    const proof = r.request().postDataJSON();
    expect(Object.keys(proof).sort()).toEqual(['challenge', 'signature']);
    expect(JSON.stringify(proof)).not.toContain(privateJWK.d);
    expect(proof.challenge).toBe(challenge);
    authenticated = await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      Buffer.from(proof.signature, 'base64url'),
      new TextEncoder().encode('pdf-owner-login-v1:' + challenge),
    );
    return r.fulfill({ json: { authenticated } });
  });
  await page.goto('/');
  await expect(page.getByLabel('Owner testing access')).toContainText(
    'application quotas disabled',
  );
  await page
    .getByLabel('Owner key file')
    .setInputFiles({
      name: 'test-owner-key.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(privateJWK)),
    });
  await expect(page.getByLabel('Owner testing access')).toContainText('Owner authenticated');
  expect(authenticated).toBe(true);
});
