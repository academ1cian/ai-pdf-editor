import type { ContextBlock } from './context';
import type { AIPlan } from './schema';
import { decimal, formatNumber } from './numbers';
import { invoiceIntent } from './instruction';

// A deliberately narrow local intent grammar: both line values and the payable
// total requested together, with one explicit amount. Other requests use Groq.
export function localInvoicePlan(blocks: ContextBlock[], instruction: string): AIPlan | undefined {
  const intent = invoiceIntent(instruction);
  if (!intent) return;
  const clarify = (clarification: string): AIPlan => ({ edits: [], clarification });
  const rates = blocks.filter((b) => b.field?.type === 'rate' && b.field.role !== 'fee');
  const candidates = rates
    .map((rate) => ({
      rate,
      charges: blocks.filter(
        (b) =>
          b.page === rate.page &&
          b.field?.row === rate.field?.row &&
          b.field?.type === 'charge' &&
          b.field.role !== 'fee',
      ),
    }))
    .filter((r) => r.charges.length === 1);
  if (candidates.length !== 1)
    return clarify(
      'Which main line should change? More than one line or no complete rate/charge pair was identified.',
    );
  const {
    rate,
    charges: [charge],
  } = candidates[0];
  const totals = blocks.filter((b) => b.field?.type === 'total');
  const sources = blocks.filter((b) => ['charge', 'fee'].includes(b.field?.type || ''));
  if (totals.length !== 1 || !sources.length || !blocks.every((b) => b.complete))
    return clarify(
      'The payable total and all its line charges could not be established. No changes were made.',
    );
  const total = totals[0];
  try {
    const before = sources.reduce((sum, b) => sum + decimal(b.text), 0n);
    if (before !== decimal(total.text))
      return clarify(
        'The original charges do not reconcile with the payable total. No changes were made.',
      );
    const fee = before - decimal(charge.text),
      value = intent.amount;
    const edit = (b: ContextBlock, replacement: string) => ({
      id: b.id,
      operation: 'replace' as const,
      page: b.page,
      blockId: b.id,
      original: b.text,
      replacement,
      explanation: 'Requested main-line change; preserve all other line charges.',
      ambiguity: 'none' as const,
    });
    const currency = total.text.match(/^[$£€]/)?.[0] || '';
    const money = (amount: bigint) =>
      formatNumber(amount, currency + '0,000.00').replace(/\.00$/, '');
    return {
      interpretation: `Set the main line’s rate and charge to ${money(value)}, keep the ${money(fee)} in separate fees, and update the payable total to ${money(value + fee)}.`,
      alternatives: [],
      edits: [
        edit(rate, formatNumber(value, rate.text)),
        edit(charge, formatNumber(value, charge.text)),
        {
          ...edit(total, formatNumber(value + fee, total.text)),
          calculation: {
            operation: 'sum',
            sources: sources.map((b) => ({ blockId: b.id, page: b.page, original: b.text })),
          },
        },
      ],
    };
  } catch {
    return clarify('The financial values could not be read unambiguously. No changes were made.');
  }
}
