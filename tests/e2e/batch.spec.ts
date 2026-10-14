import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import AxeBuilder from '@axe-core/playwright';
async function queueField(
  page: import('@playwright/test').Page,
  text: string,
  replacement: string,
  occurrence = 0,
) {
  await page.getByLabel('Find in document').fill(text);
  await page
    .getByRole('button', {
      name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*Occurrence'),
    })
    .nth(occurrence)
    .click();
  await page.getByLabel('Replace with', { exact: true }).fill(replacement);
  await page.getByRole('button', { name: 'Add to changes', exact: true }).click();
}
test('manual non-contiguous batch across pages → atomic apply → real download → independent reopen → one undo', async ({
  page,
}, testInfo) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/plan') requests.push(request.url());
  });
  const input = resolve('tests/fixtures/32-batch-invoice.pdf'),
    original = readFileSync(input);
  await page.goto('/');
  await page.getByRole('tab',{name:'Find & replace',exact:true}).click();
  await page.getByLabel('Upload PDF').setInputFiles(input);
  await expect(page.getByRole('img', { name: 'PDF page 1' })).toBeVisible();
  await queueField(page, '0089033', '1000');
  await queueField(page, 'Project Office', 'Records');
  await queueField(page, '1205.00', '995.00');
  await page.getByLabel('Page', { exact: true }).selectOption({ value: '2' });
  await expect(page.getByRole('img', { name: 'PDF page 3' })).toBeVisible();
  await queueField(page, '10/13/2026', '10/14/2026', 2);
  await expect(page.locator('.batch-item')).toHaveCount(4);
  await page.getByLabel('Page', { exact: true }).selectOption({ value: '0' });
  await expect(page.locator('.queued-highlight')).toHaveCount(3);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.getByRole('button', { name: 'Review all changes', exact: true }).click();
  await expect(page.getByText('All changes fit.', { exact: false })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/batch-review.png', fullPage: true });
  await page.getByRole('button', { name: 'Apply all changes', exact: true }).click();
  await expect(page.getByText('Export validated', { exact: true })).toBeVisible();
  await expect(page.locator('.batch-item')).toHaveCount(0);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const download = await downloadEvent,
    path = testInfo.outputPath('batch-edited.pdf');
  await download.saveAs(path);
  const output = new Uint8Array(readFileSync(path));
  const task = getDocument({
    data: output,
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
  });
  const doc = await task.promise;
  expect(doc.numPages).toBe(3);
  const pages: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(
      content.items
        .filter((x) => 'str' in x)
        .map((x) => ('str' in x ? x.str : ''))
        .join(' '),
    );
  }
  for (const text of ['1000', 'Records', '995.00', 'ARCHIVE-42', '90.00'])
    expect(pages[0]).toContain(text);
  expect(pages[0]).not.toContain('Project Office');
  expect(pages[0]).not.toContain('1205.00');
  expect(pages[0]).toContain('ORDER NUMBER 0089033');
  expect(pages[1]).toContain('1205.00');
  expect(pages[2]).toContain('10/14/2026');
  expect(pages[2]).not.toContain('10/13/2026');
  await task.destroy();
  expect(readFileSync(input)).toEqual(original);
  await page.screenshot({ path: 'docs/screenshots/batch-applied.png', fullPage: true });
  await page.getByRole('button', { name: 'Undo last edit' }).click();
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
  await page.getByLabel('Find in document').fill('1000');
  await expect(page.getByText('No exact match.', { exact: false })).toBeVisible();
  await page.getByLabel('Find in document').fill('0089033');
  await expect(page.getByText('6 MATCHES · CHOOSE ONE')).toBeVisible();
  expect(requests).toEqual([]);
});
test('native drag selects exact fragments across two lines and adds both to persistent batch', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab',{name:'Find & replace',exact:true}).click();
  await page.getByLabel('Upload PDF').setInputFiles(resolve('tests/fixtures/32-batch-invoice.pdf'));
  const first = page.getByRole('button', { name: 'Select text: Review required', exact: true });
  const last = page.getByRole('button', { name: 'Select text: Delivery pending', exact: true });
  await first.scrollIntoViewIfNeeded();
  const a = await first.locator('.text-glyph').nth(7).boundingBox();
  const b = await last.locator('.text-glyph').nth(7).boundingBox();
  if (!a || !b) throw new Error('Native selection glyph bounds missing.');
  await page.mouse.move(a.x + 0.1, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 0.1, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
  await expect(
    page.getByRole('button', { name: 'Review replacement', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Add to changes', exact: true }).click();
  await expect(page.locator('.batch-item')).toHaveCount(2);
  await expect(page.locator('.batch-original').nth(0)).toHaveText('required');
  await expect(page.locator('.batch-original').nth(1)).toHaveText('Delivery');
  await page.getByLabel('Replacement 1', { exact: true }).fill('ready');
  await page.getByLabel('Replacement 2', { exact: true }).fill('Ship');
  await page.getByRole('button', { name: 'Review all changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply all changes', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply all changes', exact: true }).click();
  await expect(page.getByText('Export validated', { exact: true })).toBeVisible();
});
test('invalid item prevents entire batch; removing it permits one transaction, then reset restores original', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab',{name:'Find & replace',exact:true}).click();
  await page.getByLabel('Upload PDF').setInputFiles(resolve('tests/fixtures/32-batch-invoice.pdf'));
  await queueField(page, '0089033', '1000');
  await queueField(page, '1205.00', 'This replacement is too long');
  await page.getByRole('button', { name: 'Review all changes', exact: true }).click();
  await expect(page.locator('.batch-summary')).toContainText('Change 2');
  await expect(page.getByRole('button', { name: 'Apply all changes', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo last edit' })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove change 2', exact: true }).click();
  await page.getByRole('button', { name: 'Review all changes', exact: true }).click();
  await page.getByRole('button', { name: 'Apply all changes', exact: true }).click();
  await expect(page.getByText('Export validated', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset to original', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
  await page.getByLabel('Find in document').fill('0089033');
  await expect(page.getByText('6 MATCHES · CHOOSE ONE')).toBeVisible();
});
test('Ctrl/Cmd-assisted independent selection and common replacement work without AI', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('tab',{name:'Find & replace',exact:true}).click();
  await page.getByLabel('Upload PDF').setInputFiles(resolve('tests/fixtures/12-duplicates.pdf'));
  const lines = page.getByRole('button', { name: 'Select text: John Smith', exact: true });
  await expect(lines).toHaveCount(2);
  await lines.nth(0).click({ modifiers: ['ControlOrMeta'] });
  await lines.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.batch-item')).toHaveCount(2);
  await page.getByLabel('Same replacement for included changes').fill('Jane Doe');
  await page.getByRole('button', { name: 'Set included replacements', exact: true }).click();
  await page.getByRole('button', { name: 'Review all changes', exact: true }).click();
  await page.getByRole('button', { name: 'Apply all changes', exact: true }).click();
  await expect(page.getByText('Export validated', { exact: true })).toBeVisible();
  await page.getByLabel('Find in document').fill('Jane Doe');
  await expect(page.getByText('2 MATCHES · CHOOSE ONE')).toBeVisible();
});
