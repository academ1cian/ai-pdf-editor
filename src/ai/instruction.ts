import { decimal } from './numbers';

export function invoiceIntent(instruction: string): { amount: bigint } | undefined {
  if (
    !/(?:change|set|update|поменя|измени|установ)/i.test(instruction) ||
    !/(?:\brate\b|\brates\b|рейт|ставк)/i.test(instruction) ||
    !/(?:\bcharges?\b|чарж)/i.test(instruction) ||
    !/(?:final\s+amount|\btotal\b|итог|конечн)/i.test(instruction) ||
    !/(?:accordingly|calculat|recomput|automatic|посчитай|пересч|автомат)/i.test(instruction)
  )
    return;
  if (
    /(?:\bdate\b|\bquantity\b|\bunits\b|\bweight\b|\bdescription\b|\binvoice\s+(?:number|no)\b|дат[ау]|количеств|описани)/i.test(
      instruction,
    )
  )
    return;
  if (
    /(?:\bfee\b|\bfees\b|\btax\b|сбор|налог)/i.test(instruction) &&
    !/(?:keep|preserve|retain|остав|сохран).{0,50}(?:fee|tax|сбор|налог)/i.test(instruction)
  )
    return;
  const amounts: string[] = instruction.match(/-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g) || [];
  if (!amounts.length && /(?:тысяч[ау]|\b(?:one\s+)?thousand\b)/i.test(instruction))
    amounts.push('1000');
  if (amounts.length !== 1) return;
  try {
    const amount = decimal(amounts[0]);
    if (amount <= 0n) return;
    return { amount };
  } catch {
    return;
  }
}
