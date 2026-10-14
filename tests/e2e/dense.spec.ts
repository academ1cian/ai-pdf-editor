import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
const requests = [
  'Поменяй мне rate и charge на тысячу, а final amount посчитай сам.',
  'Поменяй рейты и чаржа на тысячу долларов, а итоговую сумму пересчитай автоматически.',
  'Change the rate and the charges to 1000 and the final amount accordingly.',
  'Change the rate and charge to 1000 and calculate the final amount automatically.',
];
for (const [i, instruction] of requests.entries())
  test(`dense local invoice request ${i + 1}: preview bytes = download; cancel and atomic undo`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [],
      posts: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/plan')) posts.push(r.url());
    });
    await page.goto('/');
    await page
      .getByLabel('Upload PDF')
      .setInputFiles(resolve('tests/fixtures/dense-invoice-a.pdf'));
    await page.getByLabel('What would you like to change?', { exact: true }).fill(instruction);
    await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
    const approve = page.getByRole('button', { name: 'Apply & Download', exact: true });
    await expect(approve).toBeEnabled({ timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Undo last edit', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Discard preview', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Preview changes', exact: true }).click();
    await expect(approve).toBeEnabled({ timeout: 30000 });
    const hash = await page.locator('.app').getAttribute('data-preview-sha256');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const event = page.waitForEvent('download');
    await approve.click();
    const path = testInfo.outputPath('dense-approved.pdf');
    await (await event).saveAs(path);
    const bytes = readFileSync(path);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }),
      pdf = await task.promise;
    expect(pdf.numPages).toBe(3);
    const text = (await (await pdf.getPage(1)).getTextContent()).items
      .filter((x) => 'str' in x)
      .map((x) => ('str' in x ? x.str : ''))
      .join(' ');
    for (const value of ['1000.0000', '1000.00', '$1,065.00', '65.0000', '65.00', 'Flat rate'])
      expect(text).toContain(value);
    expect(text).not.toContain('1487.00');
    await task.destroy();
    await page.getByRole('button', { name: 'Undo last edit', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Select text: 1487.0000', exact: true }),
    ).toBeVisible();
    expect(posts).toEqual([]);
    expect(errors).toEqual([]);
  });
