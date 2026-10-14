import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  FileText,
  FolderOpen,
  Code2,
  LoaderCircle,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  Undo2,
  X,
} from 'lucide-react';
import { PDFClient } from './engine/client';
import {
  findTargets,
  targetFromRange,
  type BatchProposal,
  type Operation,
  type DocumentModel,
  type Proposal,
  type Target,
  type Validation,
} from './engine/model';
import { AIPlanSchema, type AIPlan } from './ai/schema';

import { buildContext, type ContextBlock } from './ai/context';
import { localInvoicePlan } from './ai/invoice-intent';
import { validateAnalysis } from './ai/analysis';
import { resolvePlan } from './ai/resolve';

type Preview = {id:string;sha256:string;model:DocumentModel;validation:Validation;operations:Operation[];proposals:Proposal[]};
type Config = { enabled: boolean; siteKey?: string; reason?: string };
type Change = { original: string; replacement: string; page: number; transaction: number };
type QueuedChange = Operation & { included: boolean; note?: string };
declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, options: Record<string, unknown>) => string;
      reset: (id: string) => void;
      remove: (id: string) => void;
    };
  }
}
const BUILD_COMMIT = import.meta.env.VITE_BUILD_COMMIT || 'local-unpublished';
const SOURCE = import.meta.env.VITE_SOURCE_URL || 'https://github.com/academ1cian/ai-pdf-editor';
function save(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(
    new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function App() {
  const client = useRef<PDFClient | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const viewer = useRef<HTMLDivElement>(null);
  const captcha = useRef<HTMLDivElement>(null);
  const previewReview=useRef<HTMLElement>(null);
  const captchaId = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const modal = useRef<HTMLElement>(null);
  const [model, setModel] = useState<DocumentModel>();
  const [name, setName] = useState('');
  const [page, setPage] = useState(0);
  const [scale, setScale] = useState(0.95);
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState('');
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [selected, setSelected] = useState<Target>();
  const [proposal, setProposal] = useState<Proposal>();
  const [validation, setValidation] = useState<Validation>();
  const [changes, setChanges] = useState<Change[]>([]);
  const [queue, setQueue] = useState<QueuedChange[]>([]);
  const [batchReview, setBatchReview] = useState<BatchProposal>();
  const [draftTargets, setDraftTargets] = useState<Target[]>([]);
  const [bulkText, setBulkText] = useState('');
  const draggedSelection = useRef(false);
  const dragStart = useRef<
    { line: string; start: number; end: number; x: number; y: number } | undefined
  >(undefined);
  const [tab, setTab] = useState<'manual' | 'ai'>('ai');
  const [preview,setPreview]=useState<Preview>();
  const [compareOriginal,setCompareOriginal]=useState(false);
  useEffect(()=>{if(preview)previewReview.current?.scrollIntoView({block:'start'});},[preview]);
  const [renderedSnapshot,setRenderedSnapshot]=useState('');
  const [aiInterpretation,setAiInterpretation]=useState('');
  const [aiAlternatives,setAiAlternatives]=useState<NonNullable<AIPlan['alternatives']>>([]);
  const [instruction, setInstruction] = useState('');
  const [config, setConfig] = useState<Config>({
    enabled: false,
    reason: 'Checking AI availability…',
  });
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState('');
  const aiSession = useRef(sessionStorage.getItem('pdf-ai-session') || crypto.randomUUID());
  useEffect(() => { sessionStorage.setItem('pdf-ai-session', aiSession.current); }, []);
  const [aiClarification, setAiClarification] = useState('');
  const [aiQuota, setAiQuota] = useState('');
  const [aiEdits, setAiEdits] = useState<AIPlan['edits']>([]);
  const [dragging, setDragging] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const matches = useMemo(() => (model ? findTargets(model, query) : []), [model, query]);
  const getClient = () => {
    if (!client.current || client.current.closed) client.current = new PDFClient();
    return client.current;
  };
  useEffect(() => () => client.current?.destroy(), []);
  useEffect(() => {
    if (!privacy) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        modal.current?.querySelectorAll<HTMLElement>(
          'button,a[href],input,textarea,[tabindex="0"]',
        ) || [],
      );
    focusable()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPrivacy(false);
        return;
      }
      if (event.key === 'Tab') {
        const nodes = focusable();
        const first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, [privacy]);
  useEffect(() => {
    fetch('/api/config')
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setConfig)
      .catch(() =>
        setConfig({
          enabled: false,
          reason: 'AI is not configured on this installation. Manual editing is available.',
        }),
      );
  }, []);
  useEffect(() => {
    if (tab !== 'ai' || !config.enabled || !config.siteKey || !captcha.current) return;
    let stopped = false;
    const setup = () => {
      if (stopped || !captcha.current || !window.turnstile) return;
      captchaId.current = window.turnstile.render(captcha.current, {
        sitekey: config.siteKey,
        action: 'pdf-plan',
        callback: (value: string) => setToken(value),
        'expired-callback': () => setToken(''),
        'error-callback': () => setToken(''),
      });
    };
    let script = document.querySelector<HTMLScriptElement>('script[data-turnstile]');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.dataset.turnstile = 'true';
      script.async = true;
      document.head.append(script);
    }
    if (window.turnstile) setup();
    else script.addEventListener('load', setup);
    return () => {
      stopped = true;
      script?.removeEventListener('load', setup);
      if (captchaId.current) window.turnstile?.remove(captchaId.current);
      captchaId.current = undefined;
      setToken('');
    };
  }, [tab, config]);
  const clearReview = () => {
    setProposal(undefined);
    setSelected(undefined);
    setAiEdits([]);
    setAiClarification('');
    setAiInterpretation('');setAiAlternatives([]);
    setDraftTargets([]);
    setPreview(undefined);
    setCompareOriginal(false);
  };
  const load = async (file: File) => {
    if (busy) return;
    setError('');
    setNotice('');
    if (!/\.pdf$/i.test(file.name)) {
      setError('Choose a PDF file (.pdf).');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('Choose a PDF smaller than 15 MB.');
      return;
    }
    setBusy('Opening document…');
    generation.current++;
    try {
      const result = await getClient().request<{ model: DocumentModel }>(
        'load',
        new Uint8Array(await file.arrayBuffer()),
      );
      setModel(result.model);
      setConsent(false);
      setName(file.name);
      setPage(0);
      setChanges([]);
      setQueue([]);
      setBatchReview(undefined);
      setValidation(undefined);
      setQuery('');
      setReplacement('');
      clearReview();
      setNotice('Document opened. Describe your changes to preview the edited PDF.');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const loadSample = async (path: string, filename: string) => {
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error('Sample could not be loaded.');
      await load(new File([await response.blob()], filename, { type: 'application/pdf' }));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Sample could not be loaded.');
    }
  };
  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    let url = '';
    setRendering(true);
    setRenderedSnapshot('');
    const snapshot=preview&&!compareOriginal?preview.id:'original';
    const version = generation.current;
    getClient()
      .request<{ png: Uint8Array }>('render', {
        page,
        scale: Math.min(2, scale * window.devicePixelRatio),
        previewId: preview&&!compareOriginal?preview.id:undefined,
      })
      .then((result) => {
        if (cancelled || version !== generation.current) return;
        url = URL.createObjectURL(
          new Blob([result.png.slice().buffer as ArrayBuffer], { type: 'image/png' }),
        );
        setImage(url);
        setRenderedSnapshot(snapshot+':'+page);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [model, page, scale, preview, compareOriginal]);
  const choose = (target: Target) => {
    setSelected(target);
    setDraftTargets([]);
    setReplacement(target.original);
    setPage(target.page);
    setProposal(undefined);
  };
  const review = async (target = selected, text = replacement) => {
    if (!target || busy) return;
    setBusy('Checking replacement…');
    setError('');
    setValidation(undefined);
    try {
      setProposal(await getClient().request<Proposal>('propose', { target, replacement: text }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const apply = async () => {
    if (!proposal || proposal.status !== 'SAFE_TO_APPLY' || busy) return;
    setBusy('Applying and validating all pages…');
    setError('');
    try {
      const result = await getClient().request<{
        model: DocumentModel;
        validation: Validation;
        edits: number;
      }>('apply', proposal);
      setModel(result.model);
      setValidation(result.validation);
      setChanges((c) => [
        ...c,
        {
          original: proposal.target.original,
          replacement: proposal.replacement,
          page: proposal.target.page + 1,
          transaction: result.edits,
        },
      ]);
      setQuery('');
      setQueue([]);
      setBatchReview(undefined);
      clearReview();
      setNotice('Edit applied and export validated. Your original file is unchanged.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const restore = useCallback(
    async (type: 'undo' | 'reset') => {
      if (busy) return;
      setBusy(type === 'undo' ? 'Undoing edit…' : 'Restoring original…');
      setError('');
      try {
        const result = await getClient().request<{ model: DocumentModel }>(type);
        setModel(result.model);
        setChanges((c) =>
          type === 'undo' ? c.filter((item) => item.transaction !== c.at(-1)?.transaction) : [],
        );
        setQueue([]);
        setBatchReview(undefined);
        clearReview();
        setValidation(undefined);
        setNotice(type === 'undo' ? 'Last edit undone.' : 'Original document restored.');
        setQuery('');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [busy],
  );
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === 'z' &&
        !['INPUT', 'TEXTAREA'].includes(target.tagName) &&
        changes.length
      ) {
        e.preventDefault();
        void restore('undo');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [restore, changes.length]);
  const fit = () => {
    if (!model || !viewer.current) return;
    const width = model.pages[page].bounds[2] - model.pages[page].bounds[0];
    setScale(Math.max(0.35, Math.min(1.6, (viewer.current.clientWidth - 100) / width)));
  };
  const localPlan = model ? localInvoicePlan(buildContext(model,instruction,page),instruction) : undefined;
  const useLocal = !!localPlan && !consent;
  const askAI = async () => {
    if (!model || busy || (!useLocal && (!consent || !config.enabled || !token))) return;
    if(queue.length){setError('Apply or clear the manual change list before preparing an AI preview.');return;}
    setPreview(undefined);setCompareOriginal(false);setRenderedSnapshot('');
    setBusy('Preparing AI proposals…');
    setError('');
    try {
      const context = buildContext(model,instruction,page);
      if(!context.length)throw new Error('This PDF has no selectable text. Scans need OCR before this editor can prepare changes.');
      setAiEdits([]);
      setAiClarification('');
      setAiInterpretation('');setAiAlternatives([]);
      if(useLocal && localPlan) {
        const plan=validateAnalysis(localPlan,context,instruction);
        setAiEdits(plan.edits);setAiClarification(plan.clarification||'');setAiInterpretation(plan.interpretation||'');setAiAlternatives([]);
        setAiQuota('Interpreted on this device. No provider request or document text transmission.');
        if(plan.edits.length)await preparePreview(plan,context);
        setNotice(plan.edits.length?'Review the actual edited document, then Apply & Download.':plan.clarification||'No changes proposed.');
        return;
      }
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction, blocks: context, turnstileToken: token, sessionId: aiSession.current }),
        signal: AbortSignal.timeout(35000),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error || 'AI could not prepare a proposal. Manual editing remains available.',
        );
      const plan = AIPlanSchema.parse(body);
      setAiEdits(plan.edits);
      setAiClarification(plan.clarification || '');
      setAiInterpretation(plan.interpretation||'');
      setAiAlternatives(plan.alternatives||[]);
      if(plan.edits.length)await preparePreview(plan,context);
      const remaining=response.headers.get('X-AI-Remaining-Requests');
      const globalRequests=response.headers.get('X-AI-Global-Requests-Used');
      const globalTokens=response.headers.get('X-AI-Global-Tokens-Used');
      setAiQuota((remaining && remaining!=='unknown' ? remaining+' requests remain in this session’s application allowance. ' : '')+(globalRequests && globalTokens ? 'Shared application usage today: '+globalRequests+'/80 requests and '+globalTokens+'/100,000 tokens. ' : '')+'Groq rate limits are separate.');
      setNotice(
        plan.edits.length
          ? 'Review the actual edited document, then Apply & Download.'
          : plan.clarification || 'No matching edit was proposed. Try a more specific instruction.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'AI is unavailable. Use manual editing.');
    } finally {
      setBusy('');
      setToken('');
      if (captchaId.current) window.turnstile?.reset(captchaId.current);
    }
  };
  const preparePreview=async(plan:AIPlan,context:ContextBlock[])=>{
    if(!model)return;
    const operations=resolvePlan(model,plan,context);
    setBusy('Editing and checking a working copy…');
    const result=await getClient().request<Preview>('previewBatch',operations);
    setPreview(result);setCompareOriginal(false);setRenderedSnapshot('');
    setPage(operations[0].target.page);
  };
  const approvePreview=async()=>{
    if(!preview||busy||compareOriginal||renderedSnapshot!==preview.id+':'+page)return;
    setBusy('Preparing your approved PDF…');setError('');
    try{
      const result=await getClient().request<{model:DocumentModel;validation:Validation;bytes:Uint8Array;edits:number}>('commitPreview',preview.id);
      setModel(result.model);setValidation(result.validation);
      setChanges(current=>[...current,...preview.operations.map(op=>({original:op.target.original,replacement:op.replacement,page:op.target.page+1,transaction:result.edits}))]);
      setQueue([]);setBatchReview(undefined);clearReview();setQuery('');
      save(result.bytes,name.replace(/\.pdf$/i,'')+'-edited.pdf');
      setNotice('Approved PDF downloaded. One Undo restores all changes in this instruction.');
    }catch(e){setError((e as Error).message);}finally{setBusy('');}
  };
  const discardPreview=()=>{
    setPreview(undefined);setCompareOriginal(false);setAiEdits([]);setAiClarification('');setAiInterpretation('');setAiAlternatives([]);setRenderedSnapshot('');
    void getClient().request('discardPreview').catch(()=>{});
    setNotice('Preview discarded. Your document is unchanged.');
  };

  const enqueue = (targets: Target[], replacements?: string[], notes?: string[]) => {
    if (busy || !targets.length) return;
    const additions = targets
      .map((target, index) => ({
        target,
        replacement: replacements?.[index] ?? target.original,
        note: notes?.[index],
        included: true,
      }))
      .filter((item) => !queue.some((current) => current.target.id === item.target.id));
    if (!additions.length) {
      setNotice('This selection is already in your change list.');
      return;
    }
    if (queue.length + additions.length > 40) {
      setError('A batch supports up to 40 changes. Nothing was added; choose fewer spans.');
      return;
    }
    setQueue([...queue, ...additions]);
    setBatchReview(undefined);
    setProposal(undefined);
    setNotice('Selection added. Edit each replacement below, then review all changes together.');
  };
  const editQueue = (
    id: string,
    patch: Partial<Pick<QueuedChange, 'replacement' | 'included'>>,
  ) => {
    setQueue((current) =>
      current.map((item) => (item.target.id === id ? { ...item, ...patch, note: patch.replacement!==undefined ? 'Replacement was manually adjusted; review any dependent calculation again.' : item.note } : item)),
    );
    setBatchReview(undefined);
  };
  const reviewBatch = async () => {
    if (busy || !queue.some((item) => item.included)) return;
    setBusy('Checking all replacements…');
    setError('');
    try {
      setBatchReview(
        await getClient().request<BatchProposal>(
          'proposeBatch',
          queue
            .filter((item) => item.included)
            .map(({ target, replacement }) => ({ target, replacement })),
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const applyBatch = async () => {
    if (busy || batchReview?.status !== 'SAFE_TO_APPLY') return;
    setBusy('Applying batch and validating all pages…');
    setError('');
    try {
      const operations = queue
        .filter((item) => item.included)
        .map(({ target, replacement }) => ({ target, replacement }));
      const result = await getClient().request<{
        model: DocumentModel;
        validation: Validation;
        edits: number;
      }>('applyBatch', operations);
      setModel(result.model);
      setValidation(result.validation);
      setChanges((current) => [
        ...current,
        ...operations.map((op) => ({
          original: op.target.original,
          replacement: op.replacement,
          page: op.target.page + 1,
          transaction: result.edits,
        })),
      ]);
      setQueue([]);
      setBatchReview(undefined);
      clearReview();
      setQuery('');
      setNotice(
        `${operations.length} changes applied together and export validated. One Undo reverses the batch.`,
      );
    } catch (e) {
      setError((e as Error).message);
      setBatchReview(undefined);
    } finally {
      setBusy('');
    }
  };
  const captureSelection = (add: boolean, event?: ReactMouseEvent<HTMLDivElement>) => {
    if (!model || busy) return;
    // Browser native ranges differ for absolutely positioned glyphs (notably Firefox).
    // Pointer endpoints resolve exact character intervals against the document model.
    const anchor = dragStart.current;
    dragStart.current = undefined;
    if (event) {
      if (!anchor || Math.hypot(event.clientX - anchor.x, event.clientY - anchor.y) < 3) return;
      const layer = viewer.current?.querySelector('.text-layer');
      const hit = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-line-id]');
      if (!hit || !layer?.contains(hit)) return;
      const lines = model.pages[page].lines;
      const ai = lines.findIndex((line) => line.id === anchor.line);
      const bi = lines.findIndex((line) => line.id === hit.dataset.lineId);
      if (ai < 0 || bi < 0) return;
      const end = { start: Number(hit.dataset.charStart), end: Number(hit.dataset.charEnd) };
      const forward = ai < bi || (ai === bi && anchor.start <= end.start);
      const targets: Target[] = [];
      for (let i = Math.min(ai, bi); i <= Math.max(ai, bi); i++) {
        const start = i === Math.min(ai, bi) ? (forward ? anchor.start : end.start) : 0;
        const finish =
          i === Math.max(ai, bi) ? (forward ? end.end : anchor.end) : lines[i].text.length;
        const target = targetFromRange(model, page, lines[i].id, start, finish);
        if (target) targets.push(target);
      }
      if (!targets.length) return;
      draggedSelection.current = true;
      setDraftTargets(targets);
      setSelected(targets[0]);
      setQuery(targets.length === 1 ? targets[0].original : '');
      setReplacement(targets.map((t) => t.original).join('\n'));
      setProposal(undefined);
      window.getSelection()?.removeAllRanges();
      if (add) enqueue(targets);
      else
        setNotice(
          `${targets.length} exact span${targets.length === 1 ? '' : 's'} selected. Use Add to changes to keep them across pages.`,
        );
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const layer = viewer.current?.querySelector('.text-layer');
    if (!layer || !layer.contains(range.startContainer) || !layer.contains(range.endContainer))
      return;
    const targets: Target[] = [];
    for (const line of model.pages[page].lines) {
      const nodes = Array.from(layer.querySelectorAll<HTMLElement>('[data-line-id]')).filter(
        (el) => el.dataset.lineId === line.id,
      );
      let start = Infinity,
        end = -1;
      for (const node of nodes) {
        if (!range.intersectsNode(node)) continue;
        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(node);
        if (
          range.compareBoundaryPoints(Range.END_TO_START, nodeRange) >= 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, nodeRange) <= 0
        )
          continue;
        start = Math.min(start, Number(node.dataset.charStart));
        end = Math.max(end, Number(node.dataset.charEnd));
      }
      const target = targetFromRange(model, page, line.id, start, end);
      if (target) targets.push(target);
    }
    if (!targets.length) return;
    draggedSelection.current = true;
    setDraftTargets(targets);
    setSelected(targets[0]);
    setQuery(targets.length === 1 ? targets[0].original : '');
    setReplacement(targets.map((t) => t.original).join('\n'));
    setProposal(undefined);
    if (add) {
      enqueue(targets);
      selection.removeAllRanges();
    } else
      setNotice(
        `${targets.length} exact span${targets.length === 1 ? '' : 's'} selected. Use Add to changes to keep them across pages.`,
      );
  };

  const download = async () => {
    setBusy('Preparing download…');
    setError('');
    try {
      save(
        await getClient().request<Uint8Array>('export'),
        name.replace(/\.pdf$/i, '') + '-edited.pdf',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const displayModel=preview&&!compareOriginal?preview.model:model;
  const currentPage = displayModel?.pages[page];
  const bounds = currentPage?.bounds;
  const pageWidth = bounds ? (bounds[2] - bounds[0]) * scale : 0;
  const pageHeight = bounds ? (bounds[3] - bounds[1]) * scale : 0;
  return (
    <div
      className="app"
      data-build-commit={BUILD_COMMIT}
      data-preview-id={preview?.id||''}
      data-preview-sha256={preview?.sha256||''}
      data-rendered-snapshot={renderedSnapshot}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) void load(file);
      }}
    >
      <header className="topbar">
        <a className="brand" href="/" aria-label="AI PDF Editor home">
          <span className="brand-icon">
            <FileText size={20} />
          </span>
          <span>
            AI PDF <strong>Editor</strong>
            <span className="beta">BETA</span>
          </span>
        </a>
        <div className="document-name">
          {name ? (
            <>
              <span className="dot" />
              {name}
            </>
          ) : (
            <span>A little change. The same document.</span>
          )}
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            title="Undo (Ctrl+Z)"
            aria-label="Undo last edit"
            disabled={!changes.length || !!busy}
            onClick={() => restore('undo')}
          >
            <Undo2 size={17} />
          </button>
          <button
            className="icon-button"
            title="Reset to original"
            aria-label="Reset to original"
            disabled={!changes.length || !!busy}
            onClick={() => restore('reset')}
          >
            <RotateCcw size={16} />
          </button>
          <span className="divider" />
          <a
            className="icon-button"
            href={SOURCE}
            target="_blank"
            rel="noreferrer"
            aria-label="Source code on GitHub"
          >
            <Code2 size={18} />
          </a>
          <button
            className="primary download"
            disabled={!changes.length || !!busy || queue.length > 0 || !!preview}
            onClick={download}
          >
            <ArrowDownToLine size={16} />
            Download PDF
          </button>
        </div>
      </header>
      <input
        ref={fileInput}
        type="file"
        accept=".pdf,application/pdf"
        aria-label="Upload PDF"
        className="visually-hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void load(f);
        }}
      />
      <main className={model ? 'workspace' : 'welcome-workspace'}>
        <section className="document-area" aria-label="Document viewer" tabIndex={0}>
          <div className="document-toolbar">
            <div className="toolbar-label">
              <FileText size={15} />
              {model ? 'DOCUMENT' : 'YOUR DOCUMENT'}
              {model && (
                <span className="page-count">
                  {model.pages.length} {model.pages.length === 1 ? 'page' : 'pages'}
                </span>
              )}
            </div>
            <button
              className="text-button"
              onClick={() => fileInput.current?.click()}
              disabled={!!busy}
            >
              <FolderOpen size={15} />
              {model ? 'Open another' : 'Open PDF'}
            </button>
          </div>
          {!model ? (
            <div className="empty-view">
              <div className="empty-content">
                <span className="eyebrow">PRECISE EDITS. INTACT DOCUMENTS.</span>
                <h1>
                  The right words.
                  <br />
                  <span>The original layout.</span>
                </h1>
                <p>
                  Make a small correction without rebuilding your PDF.
                  <br />
                  Find the text, review your change, and download with confidence.
                </p>
                <button
                  className="upload-zone"
                  onClick={() => fileInput.current?.click()}
                  disabled={!!busy}
                >
                  <span className="upload-icon">
                    <Upload size={25} strokeWidth={1.5} />
                  </span>
                  <strong>Drop your PDF here</strong>
                  <span>
                    or <u>browse files</u>
                  </span>
                  <small>Selectable-text PDFs · Up to 15 MB · 80 pages</small>
                </button>
                <button
                  className="sample-link"
                  disabled={!!busy}
                  onClick={() => void loadSample('/sample.pdf', 'sample-resume.pdf')}
                >
                  Just looking? Try a sample document <ArrowRight size={14} />
                </button>
                <button className="sample-link" disabled={!!busy}
                  onClick={() => void loadSample('/invoice-demo.pdf', 'sample-invoice.pdf')}>
                  Try an invoice example <ArrowRight size={14} />
                </button>
                <div className="trust-note">
                  <ShieldCheck size={15} />
                  <span>Manual edits stay on your device. No account needed.</span>
                </div>
              </div>
              <div className="paper-decoration" aria-hidden="true">
                <div className="paper-card">
                  <span>PROJECT BRIEF</span>
                  <small>Document review · Revision 02</small>
                  <hr />
                  <p className="paper-copy">Scope, delivery dates, and a clear path to approval.</p>
                  <b>REVIEW NOTES</b>
                  <p className="paper-copy">
                    Confirm the final wording.
                    <br />
                    Keep the details in place.
                  </p>
                  <div className="decoration-highlight">
                    Small changes.
                    <br />
                    Carefully made.
                  </div>
                  <i />
                  <i />
                  <i className="short" />
                </div>
              </div>
            </div>
          ) : (
            <>
              <div
                className="viewer"
                ref={viewer}
                aria-busy={rendering || !!busy}
                tabIndex={0}
                role="region"
                aria-label="PDF page canvas"
              >
                <div className="page-paper" data-preview-revision={preview?.model.revision||''} style={{ width: pageWidth, height: pageHeight }}>
                  {image && (
                    <img
                      src={image}
                      alt={`PDF page ${page + 1}`}
                      width={pageWidth}
                      height={pageHeight}
                    />
                  )}
                  <div
                    className="text-layer"
                    aria-label={`Selectable text on page ${page + 1}`}
                    style={{pointerEvents:preview?'none':undefined}}
                    onMouseDown={(e) => {
                      const node = (e.target as HTMLElement).closest<HTMLElement>('[data-line-id]');
                      dragStart.current = node
                        ? {
                            line: node.dataset.lineId!,
                            start: Number(node.dataset.charStart),
                            end: Number(node.dataset.charEnd),
                            x: e.clientX,
                            y: e.clientY,
                          }
                        : undefined;
                      draggedSelection.current = false;
                    }}
                    onMouseUp={(e) => captureSelection(e.ctrlKey || e.metaKey, e)}
                  >
                    {currentPage?.lines.map((line) => (
                      <span
                        key={line.id}
                        className="text-line"
                        title="Select this line to edit"
                        tabIndex={busy || preview ? -1 : 0}
                        role="button"
                        aria-label={`Select text: ${line.text}`}
                        aria-disabled={!!preview||!!busy}
                        style={{
                          left: (line.rect[0] - (bounds?.[0] || 0)) * scale,
                          top: (line.rect[1] - (bounds?.[1] || 0)) * scale,
                          width: (line.rect[2] - line.rect[0]) * scale,
                          height: (line.rect[3] - line.rect[1]) * scale,
                          fontSize: (line.glyphs[0]?.size || 12) * scale,
                        }}
                        onClick={(e) => {
                          if (busy || preview) return;
                          if (draggedSelection.current) {
                            draggedSelection.current = false;
                            return;
                          }
                          setQuery(line.text);
                          const ts = findTargets(model, line.text).filter(
                            (t) => t.line === line.id,
                          );
                          if (ts[0]) {
                            choose(ts[0]);
                            if (e.ctrlKey || e.metaKey) enqueue([ts[0]]);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !busy && !preview) {
                            setQuery(line.text);
                            const t = findTargets(model, line.text).find((t) => t.line === line.id);
                            if (t) choose(t);
                          }
                        }}
                      >
                        {(() => {
                          let offset = 0;
                          return line.glyphs.map((glyph, i) => {
                            const start = offset;
                            offset += glyph.text.length;
                            return (
                              <span
                                key={i}
                                className="text-glyph"
                                data-line-id={line.id}
                                data-char-start={start}
                                data-char-end={offset}
                                style={{
                                  left: (glyph.rect[0] - line.rect[0]) * scale,
                                  top: (glyph.rect[1] - line.rect[1]) * scale,
                                  width: (glyph.rect[2] - glyph.rect[0]) * scale,
                                  height: (glyph.rect[3] - glyph.rect[1]) * scale,
                                  fontSize: glyph.size * scale,
                                  fontFamily: glyph.font.includes('Courier')
                                    ? 'Courier New, monospace'
                                    : glyph.font.includes('Times')
                                      ? 'Times New Roman, serif'
                                      : 'Arial, sans-serif',
                                  fontWeight: glyph.font.includes('Bold') ? 700 : 400,
                                  fontStyle: /Italic|Oblique/.test(glyph.font)
                                    ? 'italic'
                                    : 'normal',
                                }}
                              >
                                {glyph.text}
                              </span>
                            );
                          });
                        })()}
                      </span>
                    ))}
                  </div>
                  {preview&&!compareOriginal&&preview.proposals.filter(p=>p.target.page===page).map((p,index)=>{
                    const r=p.layoutRect||p.target.rect;
                    return <div key={'preview'+index} className="preview-highlight" aria-label={'Changed region '+(index+1)}
                      style={{left:(r[0]-(bounds?.[0]||0))*scale,top:(r[1]-(bounds?.[1]||0))*scale,width:(r[2]-r[0])*scale,height:(r[3]-r[1])*scale}}/>;
                  })}
                  {[
                    ...queue.map((item) => item.target),
                    ...(draftTargets.length ? draftTargets : selected ? [selected] : []),
                  ]
                    .filter(
                      (target, index, all) =>
                        target.page === page && all.findIndex((t) => t.id === target.id) === index,
                    )
                    .map((target) => (
                      <div
                        key={target.id}
                        className={
                          queue.some((item) => item.target.id === target.id)
                            ? 'target-highlight queued-highlight'
                            : 'target-highlight'
                        }
                        style={{
                          left: (target.rect[0] - (bounds?.[0] || 0)) * scale,
                          top: (target.rect[1] - (bounds?.[1] || 0)) * scale,
                          width: (target.rect[2] - target.rect[0]) * scale,
                          height: (target.rect[3] - target.rect[1]) * scale,
                        }}
                      />
                    ))}
                </div>
                {rendering && (
                  <span className="render-indicator">
                    <LoaderCircle className="spin" size={14} />
                    Rendering page
                  </span>
                )}
              </div>
              <div className="viewer-controls">
                <button
                  className="icon-button"
                  aria-label="Previous page"
                  disabled={page === 0 || !!busy}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ArrowLeft size={16} />
                </button>
                <span>
                  Page{' '}
                  <select
                    aria-label="Page"
                    value={page}
                    disabled={!!busy}
                    onChange={(e) => setPage(+e.target.value)}
                  >
                    {model.pages.map((_, i) => (
                      <option key={i} value={i}>
                        {i + 1}
                      </option>
                    ))}
                  </select>{' '}
                  of {model.pages.length}
                </span>
                <button
                  className="icon-button"
                  aria-label="Next page"
                  disabled={page === model.pages.length - 1 || !!busy}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ArrowRight size={16} />
                </button>
                <span className="divider" />
                <button
                  className="icon-button"
                  aria-label="Zoom out"
                  disabled={scale <= 0.35 || !!busy}
                  onClick={() => setScale((s) => Math.max(0.35, s - 0.1))}
                >
                  <Minus size={15} />
                </button>
                <span className="zoom-value">{Math.round(scale * 100)}%</span>
                <button
                  className="icon-button"
                  aria-label="Zoom in"
                  disabled={scale >= 1.6 || !!busy}
                  onClick={() => setScale((s) => Math.min(1.6, s + 0.1))}
                >
                  <Plus size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Fit to width"
                  title="Fit to width"
                  disabled={!!busy}
                  onClick={fit}
                >
                  <Maximize2 size={15} />
                </button>
              </div>
            </>
          )}
        </section>
        <aside className="inspector">
          <div className="panel-title">
            <span>Make it read right</span>
            <span className="panel-step">{model ? '2 / 3' : '1 / 3'}</span>
          </div>
          <div className="tabs" role="tablist" aria-label="Editing mode">
            <button
              role="tab"
              aria-selected={tab === 'ai'}
              className={tab === 'ai' ? 'active' : ''}
              onClick={() => setTab('ai')}
            >
              <Sparkles size={14} />
              AI assistant
            </button>
            <button
              role="tab"
              aria-selected={tab === 'manual'}
              className={tab === 'manual' ? 'active' : ''}
              onClick={() => {if(preview)discardPreview();setTab('manual');}}
            >
              <Search size={14} />
              Find & replace
            </button>

          </div>
          <div className="panel-scroll" tabIndex={0} role="region" aria-label="Editing controls">
            {tab === 'manual' ? (
              <>
                <div className="section-heading">
                  <span className="step-number">1</span>
                  <h2>Choose your text</h2>
                </div>
                <p className="hint">
                  {model
                    ? 'Select a line in the document, or find the exact words below.'
                    : 'Open a PDF to find and replace its text.'}
                </p>
                <label htmlFor="find">Find in document</label>
                <div className="input-with-icon">
                  <Search size={15} />
                  <input
                    id="find"
                    placeholder="e.g. Sales Manager"
                    value={query}
                    disabled={!model || !!busy}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSelected(undefined);
                      setProposal(undefined);
                    }}
                  />
                </div>
                {query && model && (
                  <div className="matches">
                    <span className="micro-label">
                      {matches.length} {matches.length === 1 ? 'MATCH' : 'MATCHES'}
                      {matches.length > 1 ? ' · CHOOSE ONE' : ''}
                    </span>
                    {matches.length === 0 ? (
                      <p className="hint">No exact match. Try a shorter phrase within one line.</p>
                    ) : (
                      matches.slice(0, 100).map((target, i) => (
                        <button
                          className={`match ${selected?.id === target.id ? 'selected' : ''}`}
                          key={target.id}
                          disabled={!!busy}
                          onClick={() => choose(target)}
                        >
                          <span className="match-page">{target.page + 1}</span>
                          <span>
                            <strong>{target.original}</strong>
                            <small>
                              Page {target.page + 1} · Occurrence {i + 1}
                            </small>
                          </span>
                          {selected?.id === target.id && <Check size={15} />}
                        </button>
                      ))
                    )}
                  </div>
                )}
                <div className="section-heading second">
                  <span className="step-number">2</span>
                  <h2>Write the replacement</h2>
                </div>
                <label htmlFor="replacement">Replace with</label>
                <textarea
                  id="replacement"
                  placeholder="Enter your new wording"
                  value={replacement}
                  disabled={!model || !!busy}
                  maxLength={500}
                  rows={3}
                  onChange={(e) => {
                    setReplacement(e.target.value);
                    setProposal(undefined);
                  }}
                />
                <p className="hint small">
                  Nearby whitespace and up to 5% smaller type can help it fit. Empty text removes the selection.
                </p>
                <button
                  className="primary full"
                  disabled={!selected || !!busy || draftTargets.length > 1 || queue.length > 0}
                  onClick={() => review()}
                >
                  <Search size={15} />
                  Review replacement
                </button>
                <button
                  className="secondary full add-changes"
                  disabled={!selected || !!busy || queue.length >= 40}
                  onClick={() => {
                    const targets = draftTargets.length ? draftTargets : selected ? [selected] : [];
                    const texts = replacement.split('\n');
                    if (targets.length > 1 && texts.length !== targets.length) {
                      setError(
                        'Keep one replacement line for each selected line, or edit the individual changes after adding.',
                      );
                      return;
                    }
                    enqueue(targets, targets.length > 1 ? texts : [replacement]);
                  }}
                >
                  <Plus size={14} /> Add to changes
                </button>
                <p className="hint small">
                  Drag across exact words or several lines. Ctrl/Cmd-click adds a line directly.
                  Selections stay in your list across pages.
                </p>
                {queue.length > 0 && (
                  <section className="batch-panel" aria-label="Batch changes">
                    <div className="section-heading">
                      <h2>Changes to apply</h2>
                      <span className="count">{queue.length}</span>
                      <button
                        className="text-button"
                        disabled={!!busy}
                        onClick={() => {
                          setQueue([]);
                          setBatchReview(undefined);
                        }}
                      >
                        Clear all
                      </button>
                    </div>
                    {queue.map((item, index) => {
                      const checked = batchReview?.operations.find(
                        (op) => op.target.id === item.target.id,
                      );
                      return (
                        <article className="batch-item" key={item.target.id}>
                          <div className="batch-item-heading">
                            <label className="checkbox-label">
                              <input
                                type="checkbox"
                                checked={item.included}
                                disabled={!!busy}
                                aria-label={`Include change ${index + 1}`}
                                onChange={(e) =>
                                  editQueue(item.target.id, { included: e.target.checked })
                                }
                              />
                              Change {index + 1}
                            </label>
                            <button
                              className="text-button"
                              disabled={!!busy}
                              onClick={() => setPage(item.target.page)}
                            >
                              Page {item.target.page + 1} · {item.target.rect[0].toFixed(0)},{' '}
                              {item.target.rect[1].toFixed(0)} pt
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`Remove change ${index + 1}`}
                              disabled={!!busy}
                              onClick={() => {
                                setQueue((current) =>
                                  current.filter((entry) => entry.target.id !== item.target.id),
                                );
                                setBatchReview(undefined);
                              }}
                            >
                              <X size={13} />
                            </button>
                          </div>
                          <div className="batch-original">{item.target.original}</div>
                          {item.note && <p className="hint">AI rationale: {item.note}</p>}
                          <label htmlFor={`batch-replacement-${index}`}>
                            Replacement {index + 1}
                          </label>
                          <textarea
                            id={`batch-replacement-${index}`}
                            rows={2}
                            maxLength={500}
                            value={item.replacement}
                            disabled={!!busy}
                            onChange={(e) =>
                              editQueue(item.target.id, { replacement: e.target.value })
                            }
                          />
                          <p
                            className={
                              checked?.status === 'SAFE_TO_APPLY'
                                ? 'batch-status safe'
                                : 'batch-status'
                            }
                          >
                            {!item.included
                              ? 'Excluded from this batch.'
                              : checked
                                ? checked.message
                                : 'Not reviewed yet.'}
                          </p>
                        </article>
                      );
                    })}
                    <label htmlFor="batch-common">Same replacement for included changes</label>
                    <input
                      id="batch-common"
                      value={bulkText}
                      maxLength={500}
                      disabled={!!busy}
                      onChange={(e) => setBulkText(e.target.value)}
                    />
                    <button
                      className="secondary full"
                      disabled={!!busy}
                      onClick={() => {
                        setQueue((current) =>
                          current.map((item) =>
                            item.included ? { ...item, replacement: bulkText } : item,
                          ),
                        );
                        setBatchReview(undefined);
                      }}
                    >
                      Set included replacements
                    </button>
                    <button
                      className="secondary full"
                      disabled={!!busy || !queue.some((item) => item.included)}
                      onClick={reviewBatch}
                    >
                      Review all changes
                    </button>
                    {batchReview && (
                      <p className="batch-summary" role="status">
                        {batchReview.message}
                        {batchReview.operations.map((op,i)=><span key={op.target.id} style={{display:'block'}}>Change {i+1}: {op.message}</span>)}
                      </p>
                    )}
                    <button
                      className="primary full"
                      disabled={!!busy || batchReview?.status !== 'SAFE_TO_APPLY'}
                      onClick={applyBatch}
                    >
                      <Check size={14} /> Apply all changes
                    </button>
                    <p className="hint small">
                      All included changes apply together, or none do. One Undo reverses the entire
                      batch. No AI request is needed.
                    </p>
                  </section>
                )}
              </>
            ) : (
              <>
                <div className="ai-heading">
                  <Sparkles size={19} />
                  <h2>A correction, in your words.</h2>
                </div>
                <p className="hint">
                  Describe your changes. Review the edited document, then approve and download.
                </p>
                <label htmlFor="instruction">What would you like to change?</label>
                <textarea
                  id="instruction"
                  placeholder={'e.g. Change the rate and charges to 1000 and update the total accordingly.'}
                  rows={5}
                  maxLength={1200}
                  value={instruction}
                  disabled={!model || !!busy}
                  onChange={(e) => {if(preview)discardPreview();setInstruction(e.target.value);}}
                />
                <div className={config.enabled ? 'privacy-callout' : 'availability-callout'}>
                  {useLocal ? <><ShieldCheck size={16}/><span>This invoice request is interpreted on your device. No document text is sent. To use Groq instead, opt in below.</span></> : config.enabled ? (
                    <>
                      <ShieldCheck size={16} />
                      <span>
                        Relevant extracted text, page positions, and label/value hints from selected document context (up to 50 lines, about 11,000 characters), plus your instruction, go to Groq. Context may include other pages. Your PDF stays here.
                      </span>
                    </>
                  ) : (
                    <>
                      <Sparkles size={16} />
                      <span>{config.reason}</span>
                    </>
                  )}
                </div>
                {config.enabled && model && <details className="hint"><summary>Preview text and layout sent to AI</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:220,overflow:'auto'}}>{JSON.stringify(buildContext(model,instruction,page),null,2)}</pre></details>}
                {config.enabled && (
                  <>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                      />
                      I agree to send the displayed document context to Groq for a proposal.
                    </label>
                    <div ref={captcha} className="captcha" />
                  </>
                )}
                <button
                  className="primary full"
                  disabled={
                    !model ||
                    (!useLocal && (!config.enabled || !consent || !token)) ||
                    instruction.trim().length < 3 ||
                    !!busy
                  }
                  onClick={askAI}
                >
                  <Sparkles size={15} />
                  Preview changes
                </button>
                {aiClarification && <p className="availability-callout" role="status">{aiClarification} Revise the instruction above; no changes have been queued.</p>}
                {aiQuota && <details className="hint"><summary>AI usage and limits</summary><p>{aiQuota}</p></details>}
                {aiInterpretation&&<p className="hint">{aiInterpretation}</p>}
                {aiAlternatives.map(alternative=><button className="text-button" key={alternative.label} disabled={!!busy} onClick={()=>{discardPreview();setInstruction(alternative.instruction);}}>{alternative.label}</button>)}
                {preview&&<section ref={previewReview} className="preview-review" aria-label="Edited document preview">
                  <h2>Review your edited document</h2>
                  <p className="hint">{preview.operations.length} changes prepared on a working copy. Your document stays unchanged until approval.</p>
                  <div className="preview-compare">
                    <button className={'secondary '+(!compareOriginal?'active':'')} aria-pressed={!compareOriginal} disabled={!!busy} onClick={()=>setCompareOriginal(false)}>Edited preview</button>
                    <button className={'secondary '+(compareOriginal?'active':'')} aria-pressed={compareOriginal} disabled={!!busy} onClick={()=>setCompareOriginal(true)}>Original</button>
                  </div>
                  <div className="row-actions">{[...new Set(preview.operations.map(op=>op.target.page))].map(p=><button className="text-button" key={p} disabled={!!busy} onClick={()=>setPage(p)}>Page {p+1}</button>)}</div>
                  <details><summary>Review changes and calculations</summary>{aiEdits.map(edit=><div className="ai-proposal" key={edit.id}>
                    <span className="micro-label">PAGE {edit.page} · {edit.label||'Text correction'}</span>
                    <del>{edit.original}</del><ins>{edit.replacement||'(remove text)'}</ins><p>{edit.explanation}</p>
                  </div>)}</details>
                  {preview.proposals.some(p=>p.fitting==='typography'||p.fitting==='whitespace')&&<p className="hint">Some text uses adjacent empty space or a small type adjustment. Inspect the highlighted result before approving.</p>}
                  <details className="hint"><summary>Advanced layout and integrity checks</summary>{preview.proposals.map(p=><p key={p.target.id}>{p.message}</p>)}<p>{preview.validation.checks.join('. ')}</p></details>
                  <button className="primary full" disabled={!!busy||compareOriginal||rendering||renderedSnapshot!==preview.id+':'+page} onClick={approvePreview}><Check size={15}/>Apply &amp; Download</button>
                  <div className="row-actions"><button className="text-button" disabled={!!busy} onClick={()=>{discardPreview();document.getElementById('instruction')?.focus();}}>Revise instruction</button><button className="text-button" disabled={!!busy} onClick={discardPreview}>Discard preview</button></div>
                </section>}

              </>
            )}
            {proposal && (
              <div
                className={`review-card ${proposal.status === 'SAFE_TO_APPLY' ? 'safe' : 'unsafe'}`}
              >
                <div className="review-title">
                  <ShieldCheck size={16} />
                  <h2>
                    {proposal.status === 'SAFE_TO_APPLY'
                      ? 'Ready for your review'
                      : 'This edit needs different wording'}
                  </h2>
                </div>
                <span className="micro-label">
                  PAGE {proposal.target.page + 1} · X {proposal.target.rect[0].toFixed(0)}, Y{' '}
                  {proposal.target.rect[1].toFixed(0)} PT
                </span>
                <div className="replacement-diff">
                  <del>{proposal.target.original}</del>
                  <span>
                    <ArrowDownToLine size={14} />
                  </span>
                  <ins style={{fontFamily:proposal.font?.startsWith('Times')?'Times New Roman, serif':proposal.font?.startsWith('Courier')?'Courier New, monospace':'Arial, sans-serif',fontSize:proposal.size?proposal.size+'pt':undefined,fontWeight:proposal.font?.includes('Bold')?700:400,fontStyle:/Italic|Oblique/.test(proposal.font||'')?'italic':'normal'}}>{proposal.replacement || '(remove text)'}</ins>
                </div>
                {proposal.font && (
                  <p className="font-note">
                    {proposal.font} · {proposal.size?.toFixed(1)} pt · no substitution
                  </p>
                )}
                <p className="review-message">{proposal.message}</p>
                <div className="row-actions">
                  <button
                    className="primary"
                    disabled={proposal.status !== 'SAFE_TO_APPLY' || !!busy || queue.length > 0}
                    onClick={apply}
                  >
                    <Check size={15} />
                    Apply change
                  </button>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() => setProposal(undefined)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
            {validation && (
              <div className="validation-card">
                <div>
                  <ShieldCheck size={17} />
                  <strong>Export validated</strong>
                </div>
                <p>
                  Reopened successfully. Text replaced. {validation.checkedPages}{' '}
                  {validation.checkedPages === 1 ? 'page' : 'pages'} compared; no unexpected visual
                  changes at 108 dpi.
                </p>
                <details>
                  <summary>
                    View checks <ChevronDown size={12} />
                  </summary>
                  <ul>
                    {validation.checks.map((check) => (
                      <li key={check}>
                        <Check size={12} />
                        {check}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
            {changes.length > 0 && (
              <section className="change-history">
                <div className="section-heading">
                  <h2>Applied changes</h2>
                  <span className="count">{changes.length}</span>
                </div>
                {changes.map((c, i) => (
                  <div className="history-item" key={i}>
                    <Check size={13} />
                    <span>
                      <strong>
                        {c.original} → {c.replacement || '(removed)'}
                      </strong>
                      <small>Page {c.page}</small>
                    </span>
                  </div>
                ))}
              </section>
            )}
            {!model && (
              <div className="workflow-guide">
                <span className="micro-label">A CONSIDERED WORKFLOW</span>
                <div>
                  <span>01</span>
                  <p>
                    <strong>Open your document</strong>
                    <small>The original stays untouched.</small>
                  </p>
                </div>
                <div>
                  <span>02</span>
                  <p>
                    <strong>Review every replacement</strong>
                    <small>Choose exactly what changes.</small>
                  </p>
                </div>
                <div>
                  <span>03</span>
                  <p>
                    <strong>Download a verified PDF</strong>
                    <small>Real text edits, checked before export.</small>
                  </p>
                </div>
              </div>
            )}
            {model?.warnings.map((w) => (
              <div className="availability-callout" key={w}>
                <span>{w}</span>
              </div>
            ))}
            <div className="support-note">
              <ShieldCheck size={15} />
              <p>
                Built for careful corrections.
                <br />
                <span>
                  Standard PDF fonts and short Latin text on each original line. Embedded fonts and scans are
                  view-only.
                </span>
              </p>
            </div>
          </div>
          <footer className="panel-footer">
            <span>
              <span className="dot" />
              Local PDF processing
            </span>
            <button onClick={() => setPrivacy(true)}>Privacy & limits</button>
          </footer>
        </aside>
      </main>
      <div className="statusbar" role="status" aria-live="polite">
        <span>
          {busy ? (
            <>
              <LoaderCircle size={14} className="spin" />
              {busy}
            </>
          ) : (
            notice || 'Your document. Your changes. Every edit reviewed.'
          )}
        </span>
        <span className="status-right">
          AGPL-3.0 ·{' '}
          <a href={SOURCE} target="_blank" rel="noreferrer">
            Open source
          </a>
        </span>
      </div>
      {error && (
        <div className="error-toast" role="alert">
          <X size={17} />
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={15} />
          </button>
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <Upload size={38} />
          <h2>Drop to open your PDF</h2>
          <p>Up to 15 MB. Your original stays unchanged.</p>
        </div>
      )}
      {privacy && (
        <div className="modal-backdrop" onClick={() => setPrivacy(false)}>
          <section
            ref={modal}
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="privacy-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close privacy"
              onClick={() => setPrivacy(false)}
            >
              <X size={19} />
            </button>
            <ShieldCheck size={25} />
            <h2 id="privacy-title">A careful editor, with clear limits.</h2>
            <p>
              PDFs are processed in a worker on your device. We do not upload or store your files.
              Closing this page clears your editing session.
            </p>
            <p>
              AI is optional. When configured, your instruction and a limited amount of extracted
              text and layout hints from relevant pages are sent through Cloudflare to Groq, only with your
              consent. Cloudflare Turnstile checks for abuse. Never send sensitive content you are
              not authorized to share.
            </p>
            <p>
              This version replaces printable Latin ASCII text with bounded whitespace expansion and up to 5% type reduction, in standard Helvetica,
              Times, and Courier PDF fonts. Fitting uses measured local whitespace and up to 5% smaller type; neighboring text never moves. Scans, custom
              or embedded fonts, forms, signed, encrypted, tagged, rotated, clipped, and complex
              documents may be unsupported.
            </p>
            <p>
              Validation checks text, page features, and rendered pixels at 108 dpi with a small
              antialiasing tolerance. It does not certify every PDF feature or replace professional
              document review. This is a text editor, not a secure document sanitization tool.
            </p>
            <a href={SOURCE} target="_blank" rel="noreferrer">
              Source, tests, and AGPL license <ArrowRight size={14} />
            </a>
            <button className="primary full" onClick={() => setPrivacy(false)}>
              Got it
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
