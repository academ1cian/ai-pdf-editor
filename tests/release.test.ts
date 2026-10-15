import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inspectPDF, applyBatchPDF, applyPDF, proposePDF, openPDF } from '../src/engine/pdf';
import { findTargets, History } from '../src/engine/model';
import { extractImage } from '../src/engine/images';
import { setFallbackFont } from '../src/engine/fonts';
import { localConversation, syncPendingTotal } from '../src/ai/conversation';
import { requestGroq, providerRetry } from '../worker/provider';
import { reserve, reconcile, budgetConfig } from '../worker/budget';
const fixture = (name: string) => new Uint8Array(readFileSync('tests/fixtures/' + name));
it('adds heading, overrides one pending charge, preserves rate and fee, and removes only heading', () => {
  const bytes = fixture('mixed-invoice.pdf'),
    model = inspectPDF(bytes);
  const first = localConversation(
    model,
    [],
    'Change rate and charges to 1000 and recalculate total',
  )!;
  expect(first.operations).toHaveLength(3);
  const second = localConversation(
    model,
    first.operations,
    'И ещё замени INVOICE на charlie kirk.',
  )!;
  expect(second.operations).toHaveLength(4);
  const third = localConversation(
    model,
    second.operations,
    'Нет, charge сделай 950, а итог пересчитай.',
  )!;
  expect(third.summary).toContain('Explicit charge override');
  expect(third.operations.map((o) => o.replacement)).toEqual(
    expect.arrayContaining(['1000.0000', '950.00', '$1,015.00', 'charlie kirk']),
  );
  const result = applyBatchPDF(
    bytes,
    third.operations.filter((o) => o.target.original !== 'INVOICE'),
  );
  expect(findTargets(result.model, 'INVOICE')).toHaveLength(1);
  expect(
    findTargets(result.model, '65.00').filter(
      (t) =>
        t.original === '65.00' &&
        result.model.pages[t.page].lines.find((l) => l.id === t.line)?.text === '65.00',
    ),
  ).toHaveLength(1);
  expect(result.validation.outsidePixels).toBe(0);
  const history = new History(bytes);
  history.commit(result.bytes);
  expect(history.undo()).toEqual(bytes);
});
it('resolves references to wording introduced in the pending transaction', () => {
  const model = inspectPDF(fixture('mixed-invoice.pdf'));
  const first = localConversation(model, [], 'Replace pending with ready')!;
  const second = localConversation(model, first.operations, 'Replace ready with approved')!;
  expect(second.operations).toHaveLength(1);
  expect(second.operations[0].target.original).toBe('pending');
  expect(second.operations[0].replacement).toBe('approved');
});
it('reconstructs longer heading to the left without reducing type or touching adjacent number', () => {
  const bytes = fixture('mixed-invoice.pdf'),
    target = findTargets(inspectPDF(bytes), 'INVOICE')[0],
    op = { target, replacement: 'charlie kirk' };
  const plan = proposePDF(bytes, op);
  expect(plan.size).toBeCloseTo(13);
  expect(plan.origin![0]).toBeLessThan(target.rect[0]);
  expect(plan.layoutRect![2]).toBeCloseTo(target.rect[2]);
  expect(applyPDF(bytes, op).validation.outsidePixels).toBe(0);
});
it('wraps paragraphs/cells readably, embeds Cyrillic, and rejects unbounded content', () => {
  setFallbackFont(fixture('../../src/assets/fonts/NotoSans-Regular.ttf'));
  const bytes = fixture('layout-region.pdf'),
    target = findTargets(inspectPDF(bytes), 'Cell text')[0];
  for (const replacement of [
    'A longer table cell with several carefully wrapped lines of complete selectable text.',
    'Длинный русский текст с несколькими строками для проверки',
  ]) {
    const plan = proposePDF(bytes, { target, replacement });
    expect(plan.status).toBe('SAFE_TO_APPLY');
    expect(plan.lines!.length).toBeGreaterThan(1);
    expect(plan.size).toBeGreaterThanOrEqual(9.6);
    expect(applyPDF(bytes, { target, replacement }).validation.outsidePixels).toBe(0);
  }
  expect(proposePDF(bytes, { target, replacement: 'Unbounded content '.repeat(200) }).status).toBe(
    'UNSUPPORTED',
  );
});
it('clones only one shared image occurrence and preserves other pages', () => {
  const bytes = fixture('mixed-invoice.pdf'),
    model = inspectPDF(bytes),
    image = model.pages[0].images![0];
  const result = applyBatchPDF(bytes, [], [{ id: image.id, target: image, action: 'remove' }]);
  expect(result.model.pages[0].images).toHaveLength(0);
  expect(result.model.pages[1].images).toHaveLength(2);
  expect(result.validation.outsidePixels).toBe(0);
  const sourceDoc = openPDF(bytes),
    outputDoc = openPDF(result.bytes);
  try {
    const other = model.pages[1].images!.find((i) => i.width === 900)!;
    expect(
      extractImage(
        outputDoc,
        result.model.pages[1].images!.find((i) => i.width === 900)!,
      ),
    ).toEqual(extractImage(sourceDoc, other));
  } finally {
    sourceDoc.destroy();
    outputDoc.destroy();
  }
});
it('backup is used only after primary authentication failure; quota and outages never rotate keys (mock)', async () => {
  for (const status of [401, 429, 403, 503]) {
    const keys: string[] = [];
    const result = await requestGroq(
      { GROQ_API_KEY: 'primary-test', GROQ_API_KEY_BACKUP: 'backup-test' },
      '{}',
      (async (_url, options) => {
        keys.push(new Headers(options?.headers).get('Authorization')!);
        return new Response('{}', { status: keys.length === 1 ? status : 200 });
      }) as typeof fetch,
    );
    expect(keys).toHaveLength(status === 401 ? 2 : 1);
    expect(result.credential).toBe(status === 401 ? 'backup' : 'primary');
  }
  expect(providerRetry(new Response('', { status: 429, headers: { 'retry-after': '95' } }))).toBe(
    95,
  );
});
it('bounded configurable allowances retain duplicate records after reconciliation and respect cooldowns', () => {
  const config = budgetConfig({ AI_DAILY_TOKENS: '9999999', AI_SESSION_DAY: '45' });
  expect(config.dailyTokens).toBe(180000);
  expect(config.perDay).toBe(45);
  const now = Date.parse('2026-10-15T10:00:00Z'),
    first = reserve(undefined, 'client', 100, now, config, 'network', 'request');
  expect(first.allowed).toBe(true);
  const usage = reconcile(first.usage, 'request', 50);
  expect(reserve(usage, 'client', 100, now, config, 'network', 'request').reason).toBe(
    'duplicate_reservation',
  );
  usage.providerUntil = now + 95000;
  usage.providerReason = 'provider_rate_limit';
  expect(reserve(usage, 'client', 100, now, config, 'network', 'next').retryAfter).toBe(95);
});
it('plans and validates coherent paragraph movement when wrapping needs vertical space', async () => {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib'),
    d = await PDFDocument.create(),
    font = await d.embedFont(StandardFonts.Helvetica),
    page = d.addPage([612, 792]);
  page.drawRectangle({
    x: 40,
    y: 500,
    width: 250,
    height: 210,
    borderWidth: 1,
    borderColor: rgb(0, 0, 0),
  });
  for (const [i, text] of [
    'First paragraph',
    'Second connected line',
    'Third connected line',
  ].entries())
    page.drawText(text, { x: 50, y: 680 - i * 18, size: 12, font });
  page.drawText('Unrelated footer', { x: 40, y: 40, size: 12, font });
  const bytes = await d.save(),
    model = inspectPDF(bytes),
    target = findTargets(model, 'First paragraph')[0],
    replacement =
      'A complete longer paragraph with several new lines that require the following connected lines to move coherently downward.';
  const plan = proposePDF(bytes, { target, replacement });
  expect(plan.status).toBe('SAFE_TO_APPLY');
  expect(plan.moves).toHaveLength(2);
  expect(plan.moves![0].dy).toBeGreaterThan(0);
  const result = applyPDF(bytes, { target, replacement });
  expect(result.validation.outsidePixels).toBe(0);
  expect(findTargets(result.model, 'Second connected line')[0].rect[1]).toBeCloseTo(
    findTargets(model, 'Second connected line')[0].rect[1] + plan.moves![0].dy,
    2,
  );
  expect(findTargets(result.model, 'Unrelated footer')[0].rect).toEqual(
    findTargets(model, 'Unrelated footer')[0].rect,
  );
});
it('replaces a selected shared image and preserves its other occurrence and alpha', async () => {
  const { PDFDocument } = await import('pdf-lib'),
    d = await PDFDocument.create(),
    image = await d.embedPng(fixture('invented-logo.png')),
    page = d.addPage([612, 792]);
  page.drawImage(image, { x: 40, y: 600, width: 180, height: 76 });
  page.drawImage(image, { x: 350, y: 600, width: 180, height: 76 });
  const bytes = await d.save({ useObjectStreams: false }),
    model = inspectPDF(bytes),
    target = model.pages[0].images![0];
  const result = applyBatchPDF(
    bytes,
    [],
    [
      {
        id: target.id,
        target,
        action: 'replace',
        bytes: fixture('invented-logo.png'),
        rect: [target.rect[0] + 10, target.rect[1] + 10, target.rect[2] - 10, target.rect[3] - 10],
      },
    ],
  );
  expect(result.model.pages[0].images).toHaveLength(2);
  expect(result.model.pages[0].images![1].rect).toEqual(model.pages[0].images![1].rect);
  expect(result.validation.outsidePixels).toBe(0);
});
it('substitutes a redistributable embedded font for full, subset, and Cyrillic sources', () => {
  setFallbackFont(fixture('../../src/assets/fonts/NotoSans-Regular.ttf'));
  for (const [file, original, replacement] of [
    ['29-embedded-full.pdf', 'Custom', 'Clear'],
    ['30-embedded-subset.pdf', 'Subset', 'Small'],
    ['31-cyrillic.pdf', 'Привет', 'Добрый'],
  ]) {
    const bytes = fixture(file),
      target = findTargets(inspectPDF(bytes), original)[0],
      plan = proposePDF(bytes, { target, replacement });
    expect(plan.embedded).toBe(true);
    expect(plan.font).toBe('NotoSans-Regular');
    const result = applyPDF(bytes, { target, replacement });
    expect(findTargets(result.model, replacement)).toHaveLength(1);
    expect(result.validation.outsidePixels).toBe(0);
    // Replacements introduced in an approved document remain editable.
    const next = applyPDF(result.bytes, {
      target: findTargets(result.model, replacement)[0],
      replacement: replacement + '!',
    });
    expect(findTargets(next.model, replacement + '!')).toHaveLength(1);
  }
});

it('manual refinement/removal keeps an existing derived total synchronized', () => {
  const model = inspectPDF(fixture('mixed-invoice.pdf')),
    first = localConversation(
      model,
      [],
      'Change rate and charges to 1000 and recalculate total',
    )!.operations;
  const charge = first.find((o) => o.target.original === '1487.00')!;
  const adjusted = syncPendingTotal(
    model,
    first.map((o) => (o.target.id === charge.target.id ? { ...o, replacement: '950.00' } : o)),
  );
  expect(adjusted.map((o) => o.replacement)).toContain('$1,015.00');
  const removed = syncPendingTotal(
    model,
    adjusted.filter((o) => o.target.id !== charge.target.id),
  );
  expect(removed).toHaveLength(1);
  expect(removed[0].replacement).toBe('1000.0000');
});
it('paces concurrent provider token reservations and reconciles rolling holds across midnight', () => {
  const config = budgetConfig({}),
    now = Date.parse('2026-10-15T23:59:40Z');
  const first = reserve(undefined, 'a', 5000, now, config, 'net', 'one');
  expect(first.allowed).toBe(true);
  expect(reserve(first.usage, 'b', 5000, now + 1000, config, 'other', 'two').reason).toBe(
    'global_minute',
  );
  const settled = reconcile(first.usage, 'one', 2000);
  expect(reserve(settled, 'b', 5000, now + 1000, config, 'other', 'two').allowed).toBe(true);
  expect(reserve(first.usage, 'b', 5000, now + 25000, config, 'other', 'two').reason).toBe(
    'global_minute',
  );
  expect(reserve(first.usage, 'b', 5000, now + 61000, config, 'other', 'two').allowed).toBe(true);
  expect(
    providerRetry(
      new Response('', {
        status: 429,
        headers: {
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-tokens': '15s',
          'x-ratelimit-remaining-requests': '900',
          'x-ratelimit-reset-requests': '2h',
        },
      }),
    ),
  ).toBe(15);
});
