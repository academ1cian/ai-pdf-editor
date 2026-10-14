import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
test('real upload → review → apply → download → independent reopen → undo/reset', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sourcePath = resolve('tests/fixtures/01-paragraph.pdf');
  const before = readFileSync(sourcePath);
  await page.goto('/');
  await page.getByRole('tab',{name:'Find & replace',exact:true}).click();
  await expect(page.getByRole('heading', { name: /The right words/ })).toBeVisible();
  if (process.env.EXPECTED_COMMIT_SHA) {
    await expect(page.locator('[data-build-commit]')).toHaveAttribute(
      'data-build-commit', process.env.EXPECTED_COMMIT_SHA,
    );
  }
  await page.getByLabel('Upload PDF').setInputFiles(sourcePath);
  await expect(page.getByRole('img', { name: 'PDF page 1' })).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole('img', { name: 'PDF page 1' })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByLabel('Find in document').fill('pending');
  await page.getByRole('button', { name: /pending.*Page 1/ }).click();
  await page.getByLabel('Replace with').fill('ready');
  await page.getByRole('button', { name: 'Review replacement' }).click();
  await expect(page.getByRole('heading', { name: 'Ready for your review' })).toBeVisible();
  await page.getByRole('button', { name: 'Apply change' }).click();
  await expect(page.getByText('Export validated', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/editor.png', fullPage: true });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  const download = await downloadEvent;
  const path = testInfo.outputPath('edited.pdf');
  await download.saveAs(path);
  const output = new Uint8Array(readFileSync(path));
  expect(Buffer.compare(Buffer.from(output), before)).not.toBe(0);
  const task = getDocument({
    data: output,
    standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/',
  });
  const doc = await task.promise;
  expect(doc.numPages).toBe(1);
  const content = await (await doc.getPage(1)).getTextContent();
  const text = content.items
    .filter((x) => 'str' in x)
    .map((x) => ('str' in x ? x.str : ''))
    .join(' ');
  expect(text).toContain('ready');
  expect(text).not.toContain('pending');
  await task.destroy();
  expect(readFileSync(sourcePath)).toEqual(before);
  await page.getByRole('button', { name: 'Undo last edit' }).click();
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Select text: The project status is pending.' }),
  ).toBeVisible();
  await page.getByLabel('Find in document').fill('pending');
  await page.getByRole('button', { name: /pending.*Page 1/ }).click();
  await page.getByLabel('Replace with').fill('done');
  await page.getByRole('button', { name: 'Review replacement' }).click();
  await page.getByRole('button', { name: 'Apply change' }).click();
  await expect(page.getByText('Export validated', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reset to original' }).click();
  await expect(page.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
  expect(errors).toEqual([]);
});
test('empty state, invalid file, no fake AI, and responsive layout', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab',{name:'Find & replace',exact:true}).click();
  await page.screenshot({ path: 'docs/screenshots/welcome.png', fullPage: true });
  await page
    .getByLabel('Upload PDF')
    .setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('bad') });
  await expect(page.getByRole('alert')).toContainText('Choose a PDF');
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await page.getByRole('tab', { name: 'AI assistant' }).click();
  await expect(page.getByRole('button', { name: 'Preview changes' })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'docs/screenshots/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('duplicates require selection; overflow and scanned PDFs fail safely', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab',{name:'Find & replace',exact:true}).click();
  await page.getByLabel('Upload PDF').setInputFiles(resolve('tests/fixtures/12-duplicates.pdf'));
  await expect(page.getByRole('img')).toBeVisible();
  await page.getByLabel('Find in document').fill('John Smith');
  await expect(page.getByRole('button', { name: 'Review replacement' })).toBeDisabled();
  await expect(page.getByText('2 MATCHES · CHOOSE ONE')).toBeVisible();
  await page.getByRole('button', { name: /John Smith.*Occurrence 2/ }).click();
  await page.getByLabel('Replace with').fill('This replacement is much too long to fit');
  await page.getByRole('button', { name: 'Review replacement' }).click();
  await expect(page.getByText(/pt is safely available/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply change' })).toBeDisabled();
  await page.getByLabel('Upload PDF').setInputFiles(resolve('tests/fixtures/23-scanned.pdf'));
  await expect(page.getByText(/No selectable text found/)).toBeVisible();
});
test('sample workflow and accessible editor controls', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab',{name:'Find & replace',exact:true}).click();
  const emptyAudit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(emptyAudit.violations).toEqual([]);
  await page.getByRole('button', { name: 'Just looking? Try a sample document' }).click();
  await expect(page.getByRole('img', { name: 'PDF page 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Select text: Jordan Example', exact: true }).click();
  await page.getByLabel('Replace with').fill('Robin Sample');
  await page.getByRole('button', { name: 'Review replacement' }).click();
  await expect(page.getByRole('heading', { name: 'Ready for your review' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/review.png', fullPage: true });
  await page.getByRole('button', { name: 'Apply change' }).click();
  await expect(page.getByText('Export validated', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/editor.png', fullPage: true });
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.getByRole('button', { name: 'Privacy & limits' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
