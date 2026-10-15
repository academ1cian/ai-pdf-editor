import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function upload(page: import('@playwright/test').Page, file = 'mixed-invoice.pdf') {
  await page.goto('/');
  await page.getByLabel('Upload PDF').setInputFiles(resolve('tests/fixtures/' + file));
  await expect(page.getByRole('img', { name: 'PDF page 1' })).toBeVisible();
}
async function request(page: import('@playwright/test').Page, text: string) {
  await page.locator('#instruction').fill(text);
  await page.getByRole('button', { name: /^(Preview changes|Update preview)$/ }).click();
  await expect(page.locator('#instruction')).toBeEnabled();
}
async function approve(page: import('@playwright/test').Page, path: string) {
  await expect(page.getByRole('button', { name: 'Apply & Download', exact: true })).toBeEnabled();
  const expected = await page.locator('[data-preview-sha256]').getAttribute('data-preview-sha256');
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Apply & Download', exact: true }).click();
  await (await event).saveAs(path);
  const bytes = readFileSync(path);
  expect(sha(bytes)).toBe(expected);
  return bytes;
}
async function text(bytes: Buffer) {
  const task = getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
  });
  try {
    const pdf = await task.promise;
    return (await (await pdf.getPage(1)).getTextContent()).items
      .filter((x) => 'str' in x)
      .map((x) => ('str' in x ? x.str : ''))
      .join(' ');
  } finally {
    await task.destroy();
  }
}
test('complete financial conversation retains earlier edits, charge override, remove heading, exact download and atomic Undo', async ({
  page,
}, info) => {
  await upload(page);
  await request(page, 'Change rate and charges to 1000 and recalculate total');
  await expect(page.locator('[data-preview-id]')).not.toHaveAttribute('data-preview-id', '');
  await request(page, 'И ещё замени INVOICE на charlie kirk.');
  await expect(page.getByLabel('Edited document preview')).toContainText('4 changes prepared');
  await request(page, 'Нет, charge сделай 950, а итог пересчитай.');
  await expect(page.getByLabel('Conversation history')).toContainText('Explicit charge override');
  await page.getByRole('button', { name: 'Remove change 4', exact: true }).click();
  await expect(page.getByLabel('Edited document preview')).toContainText('3 changes prepared');
  const bytes = await approve(page, info.outputPath('conversation.pdf')),
    content = await text(bytes);
  for (const value of ['1000.0000', '950.00', '$1,015.00', '65.00', 'INVOICE'])
    expect(content).toContain(value);
  expect(content).not.toContain('charlie kirk');
  await page.getByRole('button', { name: 'Undo last edit' }).click();
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
});
test('simple followup, failed followup preserves preview, earlier message invalidates dependents', async ({
  page,
}, info) => {
  await upload(page);
  await request(page, 'Replace pending with ready');
  await request(page, 'Replace ready with approved');
  const before = await page.locator('[data-preview-sha256]').getAttribute('data-preview-sha256');
  await request(page, 'Replace absent wording with something');
  await expect(page.getByRole('alert')).toContainText(
    'previous validated preview remains available',
  );
  await expect(page.locator('[data-preview-sha256]')).toHaveAttribute(
    'data-preview-sha256',
    before!,
  );
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await page.getByRole('button', { name: 'Edit request 1', exact: true }).click();
  await request(page, 'Replace pending with reviewed');
  await expect(page.getByLabel('Conversation history')).not.toContainText(
    'Replace ready with approved',
  );
  const result = await text(await approve(page, info.outputPath('earlier-edit.pdf')));
  expect(result).toContain('reviewed');
  expect(result).not.toContain('approved');
});
test('image upload edits one shared occurrence in a mixed transaction', async ({ page }, info) => {
  await upload(page);
  await request(page, 'Replace INVOICE with charlie kirk');
  await page.getByText('Images & logos (1 on this page)', { exact: true }).click();
  await page.getByRole('button', { name: /Select image 1/ }).click();
  await page
    .getByLabel('Upload replacement image')
    .setInputFiles(resolve('tests/fixtures/invented-logo.png'));
  await expect(page.getByLabel('Edited document preview')).toContainText('2 changes prepared');
  const bytes = await approve(page, info.outputPath('image-upload.pdf'));
  expect(await text(bytes)).toContain('charlie kirk');
});
test('local exact logo wording reconstructs the bitmap without a provider request', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const policy = readFileSync('public/_headers', 'utf8')
    .split('Content-Security-Policy: ')[1]
    .split('\n')[0]
    .trim();
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!/^https?:/.test(request.url())) return route.continue();
    if (
      request.resourceType() !== 'document' &&
      new URL(request.url()).origin !== new URL(page.url()).origin
    )
      return route.continue();
    const response = await route.fetch();
    return route.fulfill({
      response,
      headers: { ...response.headers(), 'Content-Security-Policy': policy },
    });
  });
  await upload(page);
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/')) posts.push(r.url());
  });
  await request(page, 'В логотипе замени CARGO на TRANSPORT SERVICES, сохрани знак ARC и цвета.');
  await expect(page.getByLabel('Edited document preview')).toContainText(
    'Exact wordmark: TRANSPORT SERVICES',
    { timeout: 90000 },
  );
  await approve(page, info.outputPath('logo.pdf'));
  expect(posts).toEqual([]);
});
test('remove latest conversational request keeps earlier changes', async ({ page }, info) => {
  await upload(page);
  await request(page, 'Replace pending with ready');
  await request(page, 'Replace INVOICE with charlie kirk');
  await request(page, 'Отмени последнюю правку, остальные оставь.');
  await expect(page.getByLabel('Edited document preview')).toContainText('1 changes prepared');
  const output = await text(await approve(page, info.outputPath('undo-request.pdf')));
  expect(output).toContain('ready');
  expect(output).toContain('INVOICE');
  expect(output).not.toContain('charlie kirk');
});
test('rate-limited cloud followup preserves valid draft and still permits approval (mock API)', async ({
  page,
}, info) => {
  await page.route('**/api/config', (r) =>
    r.fulfill({ json: { enabled: true, siteKey: 'mock-site' } }),
  );
  await page.addInitScript(() => {
    let callback: ((token: string) => void) | undefined;
    window.turnstile = {
      render: (_el, options) => {
        callback = options.callback as (token: string) => void;
        queueMicrotask(() => callback?.('mock-token'));
        return 'mock-widget';
      },
      reset: () => queueMicrotask(() => callback?.('mock-token')),
      remove: () => {},
    };
  });
  let requests = 0;
  await page.route('**/api/plan', (r) => {
    requests++;
    return r.fulfill({
      status: 429,
      json: {
        error: 'Groq rate limit reached. Retry after 95 seconds.',
        code: 'provider_rate_limit',
        retryAfter: 95,
      },
    });
  });
  await upload(page);
  await request(page, 'Replace pending with ready');
  await expect(page.getByRole('button', { name: 'Apply & Download', exact: true })).toBeEnabled();
  const hash = await page.locator('.app').getAttribute('data-preview-sha256');
  await page
    .getByLabel('I agree to send the displayed document context to Groq for a proposal.', {
      exact: true,
    })
    .check();
  await page.locator('#instruction').fill('Please improve the introductory sentence.');
  await page.getByRole('button', { name: 'Update preview', exact: true }).click();
  await expect(page.getByLabel('AI retry status')).toContainText('95-second delay');
  await page.getByRole('button', { name: 'Cancel AI request', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('request cancelled');
  await expect(page.locator('.app')).toHaveAttribute('data-preview-sha256', hash!);
  await approve(page, info.outputPath('quota-preserved.pdf'));
  expect(requests).toBe(1);
});
test('sanitized SVG upload preserves a pending text edit; active SVG is rejected before rendering', async ({
  page,
}, info) => {
  await upload(page);
  await request(page, 'Replace pending with ready');
  await page.getByText('Images & logos (1 on this page)', { exact: true }).click();
  await page.getByRole('button', { name: /Select image 1/ }).click();
  const imageUpload = page.getByLabel('Upload replacement image');
  await imageUpload.setInputFiles({
    name: 'unsafe.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><script>alert(1)</script></svg>',
    ),
  });
  await expect(page.getByRole('alert')).toContainText('unsupported active');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await imageUpload.setInputFiles({
    name: 'replacement.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><circle cx="40" cy="40" r="30" fill="#41659d"/><path d="M90 20L180 20L180 60L90 60Z" fill="#d2b773" opacity="0.6"/></svg>',
    ),
  });
  await expect(page.getByLabel('Edited document preview')).toContainText('2 changes prepared');
  await approve(page, info.outputPath('svg.pdf'));
});
test('logo followup resolves introduced wording and restore keeps earlier text requests', async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await upload(page);
  await request(page, 'Replace pending with ready');
  await request(page, 'В логотипе замени CARGO на TRANSPORT SERVICES, сохрани знак ARC и цвета.');
  await request(page, 'In the logo replace TRANSPORT SERVICES with OCEAN FREIGHT.');
  await expect(page.getByLabel('Edited document preview')).toContainText(
    'Exact wordmark: OCEAN FREIGHT',
  );
  await expect(page.getByLabel('Edited document preview')).toContainText('2 changes prepared');
  await request(page, 'Логотип оставь как был.');
  await expect(page.getByLabel('Edited document preview')).toContainText('1 changes prepared');
  expect(await text(await approve(page, info.outputPath('restored-logo.pdf')))).toContain('ready');
});
