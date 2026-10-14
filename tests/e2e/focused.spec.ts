import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
test('focused dense invoice → related numeric batch → verified export and one undo',async({page},testInfo)=>{
  await page.goto('/');
  if(process.env.EXPECTED_COMMIT_SHA)await expect(page.locator('.app')).toHaveAttribute('data-build-commit',process.env.EXPECTED_COMMIT_SHA);
  const input=resolve('tests/fixtures/focused-invoice.pdf'),original=readFileSync(input);
  await page.getByLabel('Upload PDF').setInputFiles(input);
  await expect(page.getByRole('img',{name:'PDF page 1'})).toBeVisible();
  for(const [text,replacement,index] of [['1205.00','1000.00',0],['1205.00','1000.00',1],['1295.00','1090.00',0]] as const){
    await page.getByLabel('Find in document').fill(text);
    await page.getByRole('button',{name:new RegExp(text.replace('.','\\.')+'.*Occurrence')}).nth(index).click();
    await page.getByLabel('Replace with',{exact:true}).fill(replacement);
    await page.getByRole('button',{name:'Add to changes',exact:true}).click();
  }
  await page.getByRole('button',{name:'Review all changes',exact:true}).click();
  await expect(page.getByRole('button',{name:'Apply all changes',exact:true})).toBeEnabled();
  await expect(page.locator('.batch-summary')).toContainText('right edge');
  await page.screenshot({path:'docs/screenshots/focused-invoice-review.png',fullPage:true});
  await page.getByRole('button',{name:'Apply all changes',exact:true}).click();
  await expect(page.getByText('Export validated',{exact:true})).toBeVisible();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download PDF',exact:true}).click();
  const download=await downloadPromise,path=testInfo.outputPath('focused-production.pdf');
  await download.saveAs(path);
  const task=getDocument({data:new Uint8Array(readFileSync(path)),useSystemFonts:true});
  const pdf=await task.promise,content=await(await pdf.getPage(1)).getTextContent();
  const text=content.items.filter(i=>'str'in i).map(i=>'str'in i?i.str:'').join(' ');
  expect(text).toContain('1090.00');expect(text.match(/1000\.00/g)).toHaveLength(2);expect(text).not.toContain('1205.00');
  expect(text).toContain('Payment terms: 30 days. Preserve this text.');
  await task.destroy();
  expect(readFileSync(input)).toEqual(original);
  await page.screenshot({path:'docs/screenshots/focused-invoice-applied.png',fullPage:true});
  await page.getByRole('button',{name:'Undo last change',exact:true}).click();
  await expect(page.getByRole('button',{name:'Download PDF',exact:true})).toBeDisabled();
  await page.getByLabel('Find in document').fill('1205.00');
  await expect(page.getByText('2 MATCHES · CHOOSE ONE')).toBeVisible();
});
