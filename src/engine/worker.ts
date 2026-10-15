/// <reference lib="webworker" />
import wasmUrl from '../../node_modules/mupdf/dist/mupdf-wasm.wasm?url';
import type { ImageOperation, ImageInstance } from './images';
import { History, type Operation, type EditResult, type Proposal } from './model';
globalThis.$libmupdf_wasm_Module = { locateFile: () => wasmUrl };
const engine = await import('./pdf');
const { setFallbackFont } = await import('./fonts');
const fontURLs = {
  Regular: (await import('../assets/fonts/NotoSans-Regular.ttf?url')).default,
  Bold: (await import('../assets/fonts/NotoSans-Bold.ttf?url')).default,
  Italic: (await import('../assets/fonts/NotoSans-Italic.ttf?url')).default,
  BoldItalic: (await import('../assets/fonts/NotoSans-BoldItalic.ttf?url')).default,
};
await Promise.all(
  Object.entries(fontURLs).map(async ([style, url]) =>
    setFallbackFont(
      new Uint8Array(await (await fetch(url)).arrayBuffer()),
      style as import('./fonts').FontStyle,
    ),
  ),
);
let history: History | undefined;
let sequence = 0;
let draft:
  | {
      id: string;
      base: Uint8Array;
      operations: Operation[];
      images: ImageOperation[];
      proposals: Proposal[];
      output: EditResult;
    }
  | undefined;
const handleMessage = async ({
  data,
}: {
  data: { id: number; type: string; payload: unknown };
}) => {
  const { id, type, payload } = data;
  try {
    let result: unknown;
    if (type === 'load') {
      const bytes = payload as Uint8Array;
      const model = engine.inspectPDF(bytes);
      history = new History(bytes);
      draft = undefined;
      result = { model, edits: 0 };
    } else {
      if (!history) throw new Error('Open a PDF first.');
      if (type === 'normalizeImage')
        result = (await import('./images')).normalizeImagePNG(payload as Uint8Array);
      else if (type === 'extractImage') {
        const doc = engine.openPDF(history.current);
        try {
          const target = payload as ImageInstance;
          if (
            !engine
              .inspectPDF(history.current)
              .pages[target.page]?.images?.some((i) => i.id === target.id)
          )
            throw new Error('This image selection is stale.');
          result = (await import('./images')).extractImage(doc, target);
        } finally {
          doc.destroy();
        }
      } else if (type === 'render') {
        const { page, scale, previewId } = payload as {
          page: number;
          scale: number;
          previewId?: string;
        };
        if (previewId && draft?.id !== previewId)
          throw new Error('This preview expired. Prepare it again.');
        result = engine.renderPDF(previewId ? draft!.output.bytes : history.current, page, scale);
      } else if (type === 'previewBatch') {
        const operations = Array.isArray(payload)
            ? (payload as Operation[])
            : (payload as { operations: Operation[] }).operations,
          images = Array.isArray(payload)
            ? []
            : (payload as { images: ImageOperation[] }).images || [],
          base = history.current;
        const proposals = operations.length
          ? engine.proposeBatchPDF(base, operations)
          : { status: 'SAFE_TO_APPLY', message: 'Image transaction', operations: [] as Proposal[] };
        if (proposals.status !== 'SAFE_TO_APPLY') throw new Error(proposals.message);
        const output = engine.applyBatchPDF(base, operations, images);
        const previewId = 'preview-' + ++sequence + '-' + output.model.revision;
        draft = {
          id: previewId,
          base,
          operations,
          images,
          proposals: proposals.operations,
          output,
        };
        const sha256 = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', output.bytes.slice().buffer)),
        )
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        result = {
          id: previewId,
          sha256,
          model: output.model,
          validation: output.validation,
          operations,
          images,
          proposals: proposals.operations,
        };
      } else if (type === 'commitPreview') {
        const previewId = payload as string;
        if (!draft || draft.id !== previewId)
          throw new Error('This preview expired. Prepare it again.');
        const current = history.current;
        if (current.length !== draft.base.length || current.some((b, i) => b !== draft!.base[i]))
          throw new Error('The document changed after this preview. Prepare it again.');
        history.commit(draft.output.bytes);
        result = {
          model: draft.output.model,
          validation: draft.output.validation,
          bytes: draft.output.bytes.slice(),
          edits: history.length,
        };
        draft = undefined;
      } else if (type === 'discardPreview') {
        draft = undefined;
        result = { discarded: true };
      } else if (type === 'propose')
        result = engine.proposePDF(history.current, payload as Operation);
      else if (type === 'proposeBatch')
        result = engine.proposeBatchPDF(history.current, payload as Operation[]);
      else if (type === 'applyBatch') {
        draft = undefined;
        const output = engine.applyBatchPDF(history.current, payload as Operation[]);
        history.commit(output.bytes);
        result = { model: output.model, validation: output.validation, edits: history.length };
      } else if (type === 'apply') {
        draft = undefined;
        const output = engine.applyPDF(history.current, payload as Operation);
        history.commit(output.bytes);
        result = { model: output.model, validation: output.validation, edits: history.length };
      } else if (type === 'undo' || type === 'reset') {
        draft = undefined;
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
let pending = Promise.resolve();
self.onmessage = (event) => {
  pending = pending.then(() => handleMessage(event));
};
self.postMessage({ ready: true });
