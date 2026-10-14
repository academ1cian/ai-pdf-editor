import { findTargets, type DocumentModel, type Operation } from '../engine/model';
import type { AIPlan } from './schema';
import type { ContextBlock } from './context';
export function resolvePlan(model:DocumentModel,plan:AIPlan,context:ContextBlock[]):Operation[] {
  if(!plan.edits.length)throw new Error(plan.clarification||'No changes were proposed.');
  const seen=new Set<string>();
  return plan.edits.map(edit=>{
    const block=context.find(b=>b.id===edit.blockId&&b.page===edit.page);
    if(!block||edit.ambiguity!=='none')throw new Error('The plan needs clarification before preview.');
    const matches=findTargets(model,edit.original).filter(t=>t.page===edit.page-1&&t.line===(block.lineId||block.id)&&
      (block.start===undefined||t.start>=block.start)&&(block.end===undefined||t.end<=block.end));
    if(matches.length!==1)throw new Error('A proposed field could not be resolved uniquely. No edits were made.');
    if(seen.has(matches[0].id))throw new Error('The plan contains conflicting changes to the same field.');
    seen.add(matches[0].id);return {target:matches[0],replacement:edit.replacement};
  });
}
