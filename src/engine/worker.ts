/// <reference lib="webworker" />
import wasmUrl from '../../node_modules/mupdf/dist/mupdf-wasm.wasm?url';
import { History, type Operation } from './model';
globalThis.$libmupdf_wasm_Module = { locateFile: () => wasmUrl };
const engine = await import('./pdf');
let history: History | undefined;
self.onmessage = ({ data }: { data: { id: number; type: string; payload: unknown } }) => {
  const { id, type, payload } = data;
  try {
    let result: unknown;
    if (type === 'load') {
      const bytes = payload as Uint8Array;
      const model = engine.inspectPDF(bytes);
      history = new History(bytes);
      result = { model, edits: 0 };
    } else {
      if (!history) throw new Error('Open a PDF first.');
      if (type === 'render') {
        const { page, scale } = payload as { page: number; scale: number };
        result = engine.renderPDF(history.current, page, scale);
      } else if (type === 'propose')
        result = engine.proposePDF(history.current, payload as Operation);
      else if (type === 'proposeBatch')
        result = engine.proposeBatchPDF(history.current, payload as Operation[]);
      else if (type === 'applyBatch') {
        const output = engine.applyBatchPDF(history.current, payload as Operation[]);
        history.commit(output.bytes);
        result = { model: output.model, validation: output.validation, edits: history.length };
      } else if (type === 'apply') {
        const output = engine.applyPDF(history.current, payload as Operation);
        history.commit(output.bytes);
        result = { model: output.model, validation: output.validation, edits: history.length };
      } else if (type === 'undo' || type === 'reset') {
        const bytes = type === 'undo' ? history.undo() : history.reset();
        result = { model: engine.inspectPDF(bytes), edits: history.length };
      } else if (type === 'export') result = history.current;
      else throw new Error('Unknown editor operation.');
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : 'The PDF could not be processed.',
    });
  }
};
self.postMessage({ ready: true });
