// Synthetic, redistributable test documents. No real personal information.
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString } from 'pdf-lib';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
await mkdir('tests/fixtures', { recursive: true });
const cases = [
  ['01-paragraph', 'Helvetica', 12, 'The project status is pending.', 'pending', 'ready'],
  ['02-serif', 'TimesRoman', 14, 'John Smith', 'John Smith', 'Jane Doe'],
  ['03-monospace', 'Courier', 12, 'CODE: ABC123', 'ABC123', 'XYZ789'],
  ['04-large', 'Helvetica', 32, 'DRAFT', 'DRAFT', 'FINAL'],
  ['05-small', 'Helvetica', 8, 'Reference: INV-2025-12', '2025', '2026'],
  ['06-bold', 'HelveticaBold', 16, 'Sales Manager', 'Sales Manager', 'Team Lead'],
  ['07-italic', 'TimesRomanItalic', 14, 'A thoughtful sentence', 'thoughtful', 'clear'],
  ['08-bold-italic', 'HelveticaBoldOblique', 14, 'Review required', 'required', 'done'],
  ['09-shorter', 'Helvetica', 12, 'Alexander Hamilton', 'Alexander Hamilton', 'Alex'],
  ['10-longer-fits', 'Courier', 12, 'iiiiiiii', 'iiiiiiii', 'MMM'],
  ['11-overflow', 'Helvetica', 12, 'Amy', 'Amy', 'Alexandria Montgomery', 'unsupported'],
  ['12-duplicates', 'Helvetica', 12, 'John Smith', 'John Smith', 'Jane Doe', 'duplicate'],
  ['13-multipage', 'Helvetica', 12, 'Page one', 'pending', 'ready', 'multipage'],
  ['14-resume', 'Helvetica', 14, 'Jordan Example', 'Jordan Example', 'Robin Sample', 'resume'],
  ['15-invoice', 'Helvetica', 12, 'Invoice 2025-001', '2025', '2026', 'invoice'],
  ['16-table', 'Courier', 12, 'Widget A', 'Widget A', 'Gadget B', 'table'],
  ['17-vectors', 'Helvetica', 12, 'Status: pending', 'pending', 'ready', 'vectors'],
  ['18-neighbors', 'Helvetica', 12, 'John Smith', 'John Smith', 'Jane Doe', 'neighbors'],
  ['19-background', 'Helvetica', 14, 'Blue background', 'Blue', 'Teal', 'background'],
  ['20-hyperlink', 'Helvetica', 12, 'Visit example.org', 'Visit', 'See', 'link'],
  ['21-colored', 'Helvetica', 12, 'Approved later', 'later', 'now', 'color'],
  ['22-rotation', 'Helvetica', 14, 'Rotated target', 'Rotated', 'Updated', 'unsupported-rotation'],
  ['23-scanned', 'Helvetica', 12, '', 'missing', 'new', 'unsupported-scan'],
  ['24-form', 'Helvetica', 12, 'Form document', 'Form', 'Test', 'unsupported-form'],
  ['25-mixed-style', 'Helvetica', 12, 'Hello ', 'Hello world', 'Hi all', 'unsupported-mixed'],
  ['26-page-edge', 'Helvetica', 12, 'Edge target', 'target', 'text', 'edge'],
  ['27-empty-replacement', 'Helvetica', 12, 'Remove this word', 'this', '', 'delete'],
  ['28-paragraph-tight', 'TimesRoman', 11, 'The report is pending today.', 'pending', 'ready', 'paragraph'],
];
const manifest = [];
for (const [id, fontName, size, text, target, replacement, kind = 'simple'] of cases) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts[fontName]);
  const page = doc.addPage([612, 792]);
  const y = kind === 'edge' ? 10 : 640;
  if (kind === 'background') page.drawRectangle({x:30,y:610,width:400,height:70,color:rgb(.82,.91,.97)});
  if (text) page.drawText(text, {x:48,y,size,font,color:kind==='color'?rgb(.2,.4,.7):rgb(.1,.12,.15),rotate:kind==='unsupported-rotation'?degrees(20):degrees(0)});
  if (kind === 'duplicate') page.drawText(text,{x:48,y:580,size,font});
  if (kind === 'multipage') { const second=doc.addPage(); second.drawText('Status: pending',{x:48,y:640,size,font}); }
  if (kind === 'resume') {page.drawText('EXPERIENCE',{x:48,y:590,size:10,font});page.drawText('Product designer | Example Studio',{x:48,y:565,size:12,font});page.drawText('Built accessible tools for synthetic customers.',{x:48,y:540,size:10,font});}
  if (kind === 'invoice' || kind === 'table') {for(let i=0;i<4;i++){page.drawLine({start:{x:40,y:610-i*30},end:{x:530,y:610-i*30},thickness:.5});} page.drawText('Quantity     Unit cost     Total',{x:48,y:580,size:10,font});page.drawText('2            10.00         20.00',{x:48,y:550,size:10,font});}
  if (kind === 'vectors') {page.drawRectangle({x:48,y:400,width:180,height:100,borderColor:rgb(.2,.5,.5),borderWidth:3});page.drawCircle({x:350,y:450,size:35,color:rgb(.9,.6,.2)});}
  if (kind === 'neighbors') page.drawText('Keep this exactly',{x:48+font.widthOfTextAtSize(text,size)+3,y,size,font});
  if (kind === 'paragraph') page.drawText('A separate line must remain untouched.',{x:48,y:622,size,font});
  if (kind === 'unsupported-scan') {page.drawRectangle({x:48,y:600,width:300,height:40,color:rgb(.5,.5,.5)});}
  if (kind === 'unsupported-form') doc.getForm().createTextField('synthetic-name').addToPage(page,{x:48,y:500,width:200,height:24});
  if (kind === 'unsupported-mixed') page.drawText('world',{x:48+font.widthOfTextAtSize(text,size),y,size,font:await doc.embedFont(StandardFonts.HelveticaBold)});
  if (kind === 'link') {const link=doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[48,635,190,655],Border:[0,0,0],A:{Type:'Action',S:'URI',URI:PDFString.of('https://example.org')}}));page.node.set(PDFName.of('Annots'),doc.context.obj([link]));}
  await writeFile(`tests/fixtures/${id}.pdf`,await doc.save());
  manifest.push({id,target,replacement,page:kind==='multipage'?1:0,occurrence:kind==='duplicate'?1:0,expected:kind.startsWith('unsupported')||kind==='unsupported'?'EXPECTED UNSUPPORTED':'PASS',category:kind});
}
for(const [id,text,target,replacement,subset] of [
 ['29-embedded-full','Custom embedded font','Custom','Clear',false],
 ['30-embedded-subset','Subset font sample','Subset','Small',true],
 ['31-cyrillic','Привет, мир! Это пример.','Привет','Добрый',true]
]) {
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
 const font=await doc.embedFont(await readFile('node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf'),{subset});
 doc.addPage([612,792]).drawText(text,{x:48,y:640,size:14,font});
 await writeFile(`tests/fixtures/${id}.pdf`,await doc.save());
 manifest.push({id,target,replacement,page:0,occurrence:0,expected:'EXPECTED UNSUPPORTED',category:'embedded-font'});
}
await writeFile('tests/fixtures/manifest.json',JSON.stringify(manifest,null,2)+'\n');
await mkdir('public',{recursive:true});
await copyFile('tests/fixtures/14-resume.pdf','public/sample.pdf');
await copyFile('node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION','tests/fixtures/LICENSE-Liberation.txt');
console.log(`Generated ${manifest.length} distinct synthetic fixtures.`);
