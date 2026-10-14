import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
export default ts.config({ignores:['node_modules/**','dist/**','tests/evidence/**','playwright-report/**','test-results/**']},js.configs.recommended,...ts.configs.recommended,{files:['**/*.{ts,tsx,mjs}'],languageOptions:{globals:{...globals.browser,...globals.node,...globals.worker}},rules:{'@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}],'no-undef':'off'}});
