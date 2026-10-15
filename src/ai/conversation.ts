import { findTargets, type DocumentModel, type Operation } from '../engine/model';
import { buildContext } from './context';
import { localInvoicePlan } from './invoice-intent';
import { resolvePlan } from './resolve';
import { validateAnalysis } from './analysis';
import { decimal, formatNumber } from './numbers';
export interface ConversationTurn {
  id: string;
  request: string;
  summary: string;
  before: Operation[];
  after: Operation[];
  revision: string;
  beforeImages?: import('../engine/images').ImageOperation[];
  afterImages?: import('../engine/images').ImageOperation[];
}
export function mergeOperations(current: Operation[], additions: Operation[]): Operation[] {
  const byId = new Map(current.map((op) => [op.target.id, op]));
  for (const op of additions) {
    if (op.replacement === op.target.original) byId.delete(op.target.id);
    else byId.set(op.target.id, op);
  }
  return [...byId.values()];
}
export function localConversation(
  model: DocumentModel,
  pending: Operation[],
  request: string,
): { operations: Operation[]; summary: string } | undefined {
  const blocks = buildContext(model, request, 0),
    financial = localInvoicePlan(blocks, request);
  if (financial) {
    const plan = validateAnalysis(financial, blocks, request);
    if (!plan.edits.length)
      throw new Error(plan.clarification || 'No complete financial edit identified.');
    return {
      operations: mergeOperations(pending, resolvePlan(model, plan, blocks)),
      summary: plan.interpretation || 'Updated the main line and its total.',
    };
  }
  const charge = request.match(
    /(?:charges?|чарж[ау]?|charge)\s*(?:сделай|на|to|=)?\s*(\d+(?:[.,]\d+)?)/i,
  );
  if (charge && /(?:total|итог|сумм|пересчита)/i.test(request)) {
    const fields = blocks.filter((b) => b.field?.type === 'charge' && b.field.role !== 'fee'),
      totals = blocks.filter((b) => b.field?.type === 'total');
    if (fields.length !== 1 || totals.length !== 1 || !blocks.every((b) => b.complete))
      throw new Error(
        'The main charge and complete total are ambiguous. Previous preview preserved.',
      );
    const sources = blocks.filter((b) => ['charge', 'fee'].includes(b.field?.type || ''));
    if (sources.reduce((n, b) => n + decimal(b.text), 0n) !== decimal(totals[0].text))
      throw new Error('Original line charges do not reconcile with the total.');
    const targetFor = (b: (typeof fields)[number]) => {
      const matches = findTargets(model, b.text).filter(
        (t) => t.page === b.page - 1 && t.line === b.lineId,
      );
      if (matches.length !== 1) throw new Error('Charge selection is ambiguous.');
      return matches[0];
    };
    const target = targetFor(fields[0]),
      value = decimal(charge[1]);
    let operations = mergeOperations(pending, [
      { target, replacement: formatNumber(value, fields[0].text) },
    ]);
    const sum = sources.reduce((n, b) => {
      const t = targetFor(b);
      return n + decimal(operations.find((op) => op.target.id === t.id)?.replacement || b.text);
    }, 0n);
    operations = mergeOperations(operations, [
      { target: targetFor(totals[0]), replacement: formatNumber(sum, totals[0].text) },
    ]);
    return {
      operations,
      summary:
        'Explicit charge override: ' +
        formatNumber(value, fields[0].text) +
        '. Pending rate retained; total recomputed from all charges and unchanged fees.',
    };
  }
  const match =
    request
      .trim()
      .match(/(?:replace|change)\s+["“]?(.+?)["”]?\s+(?:with|to)\s+["“]?(.+?)["”]?[.!]?$/i) ||
    request.trim().match(/(?:замени|поменяй)\s+["«]?(.+?)["»]?\s+на\s+["«]?(.+?)["»]?[.!]?$/i);
  if (match) {
    const original = match[1].replace(/["“”«»]$/, ''),
      replacement = match[2].replace(/["“”«»]$/, '');
    const existing = pending.filter((op) => op.replacement.includes(original));
    if (existing.length === 1 && existing[0].replacement.split(original).length === 2)
      return {
        operations: mergeOperations(pending, [
          { ...existing[0], replacement: existing[0].replacement.replace(original, replacement) },
        ]),
        summary: 'Updated the wording introduced by an earlier pending request.',
      };
    const targets = findTargets(model, original);
    if (targets.length !== 1)
      throw new Error(
        'Choose the intended occurrence: ' +
          targets.length +
          ' matching text regions were found. Previous preview preserved.',
      );
    return {
      operations: mergeOperations(pending, [{ target: targets[0], replacement }]),
      summary: 'Added “' + original + ' → ' + replacement + '” to the pending transaction.',
    };
  }
}
export function undoRequest(request: string): boolean {
  return /(?:undo|cancel)\s+(?:the\s+)?last\s+(?:request|change)|отмени\s+последн(?:юю|ий)\s+(?:правку|запрос)/i.test(
    request,
  );
}
export function syncPendingTotal(model: DocumentModel, operations: Operation[]): Operation[] {
  const blocks = buildContext(model, 'rate charge total payable', 0),
    totals = blocks.filter((b) => b.field?.type === 'total');
  if (totals.length !== 1 || !blocks.every((b) => b.complete)) return operations;
  const targetFor = (b: (typeof blocks)[number]) =>
    findTargets(model, b.text).filter((t) => t.page === b.page - 1 && t.line === b.lineId);
  const totalTargets = targetFor(totals[0]);
  if (totalTargets.length !== 1 || !operations.some((op) => op.target.id === totalTargets[0].id))
    return operations;
  const sources = blocks.filter((b) => ['charge', 'fee'].includes(b.field?.type || ''));
  if (!sources.length) return operations;
  try {
    if (sources.reduce((n, b) => n + decimal(b.text), 0n) !== decimal(totals[0].text))
      return operations;
    const sum = sources.reduce((n, b) => {
      const targets = targetFor(b);
      if (targets.length !== 1) throw new Error('ambiguous');
      return (
        n + decimal(operations.find((op) => op.target.id === targets[0].id)?.replacement || b.text)
      );
    }, 0n);
    return mergeOperations(operations, [
      { target: totalTargets[0], replacement: formatNumber(sum, totals[0].text) },
    ]);
  } catch {
    throw new Error(
      'A pending financial source is not an unambiguous number. Correct it before recalculating the total.',
    );
  }
}
