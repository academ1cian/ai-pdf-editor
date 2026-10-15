import * as mupdf from 'mupdf';
export type FontStyle = 'Regular' | 'Bold' | 'Italic' | 'BoldItalic';
const fallbacks = new Map<FontStyle, Uint8Array>();
export function setFallbackFont(bytes: Uint8Array, style: FontStyle = 'Regular') {
  fallbacks.set(style, bytes.slice());
}
export function standardFontName(name: string) {
  return /^(?:Helvetica(?:-Bold|-Oblique|-BoldOblique)?|Times-(?:Roman|Bold|Italic|BoldItalic)|Courier(?:-Bold|-Oblique|-BoldOblique)?)$/.test(
    name,
  );
}
export function replacementFont(original: string, text: string): mupdf.Font {
  if (standardFontName(original) && /^[\x20-\x7e\n]*$/.test(text)) return new mupdf.Font(original);
  const bold = /bold|black|heavy|semibold/i.test(original),
    italic = /italic|oblique/i.test(original),
    style: FontStyle =
      bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular',
    data = fallbacks.get(style);
  if (!data)
    throw new Error('The required Unicode font style has not loaded. Please reopen the document.');
  const font = new mupdf.Font('NotoSans-' + style, data);
  for (const c of text)
    if (c !== '\n' && !font.encodeCharacter(c)) {
      font.destroy();
      throw new Error('The embedded Noto Sans font does not contain a requested character.');
    }
  return font;
}
