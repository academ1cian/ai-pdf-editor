import {readdir,readFile,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
const root=JSON.parse(await readFile('package.json','utf8'));
const inventory=[];
for(const folder of await readdir('node_modules/.pnpm')){
 const dir=path.join('node_modules/.pnpm',folder,'node_modules');let entries;try{entries=await readdir(dir);}catch{continue;}
 for(const name of entries){if(name.startsWith('.'))continue;const names=name.startsWith('@')?(await readdir(path.join(dir,name))).map(x=>`${name}/${x}`):[name];
  for(const pkgName of names){const base=path.join(dir,pkgName);try{if(!(await stat(base)).isDirectory())continue;const p=JSON.parse(await readFile(path.join(base,'package.json'),'utf8'));const files=(await readdir(base)).filter(n=>/^(license|licence|copying|notice)/i.test(n));inventory.push({name:p.name,version:p.version,license:p.license||'UNDECLARED - REVIEW',scope:root.dependencies?.[p.name]?'runtime':root.devDependencies?.[p.name]?'direct development':'transitive',licenseFiles:files});}catch{/* non-package entry */}}
 }
}
const unique=[...new Map(inventory.map(p=>[`${p.name}@${p.version}`,p])).values()].sort((a,b)=>a.name.localeCompare(b.name));
await writeFile('docs/dependency-licenses.json',JSON.stringify(unique,null,2)+'\n');
await writeFile('docs/DEPENDENCY-LICENSES.md','# Dependency license inventory\n\nGenerated from installed package manifests and available license/notice files; lockfile records exact versions. This inventory is not a substitute for reviewing upstream license texts.\n\nThe combined application is **AGPL-3.0-only** because it ships MuPDF WASM (AGPL-3.0-or-later). Proprietary reuse of the combined engine is not permitted under this distribution; obtain an appropriate Artifex commercial license or replace MuPDF and review all licenses. No commercial license was purchased.\n\nUI fonts DM Sans / Manrope and embedded synthetic-fixture Liberation Sans carry SIL OFL-1.1 notices. PDF.js also distributes Foxit standard fonts under its bundled notice. Preserve notices when redistributing build/test dependencies.\n\n| Package | Version | License declared upstream | Use | License files |\n|---|---|---|---|---|\n'+unique.map(p=>`| ${p.name} | ${p.version} | ${typeof p.license==='string'?p.license:JSON.stringify(p.license)} | ${p.scope} | ${p.licenseFiles.join(', ')||'not packaged at root; see upstream'} |`).join('\n')+'\n');
console.log(`Inventoried ${unique.length} installed package versions.`);
