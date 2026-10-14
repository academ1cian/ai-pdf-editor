import {z} from 'zod';
export const AIEditSchema=z.object({
  id:z.string().min(1).max(80),operation:z.literal('replace'),page:z.number().int().min(1).max(80),
  blockId:z.string().min(1).max(60),original:z.string().min(1).max(500),replacement:z.string().max(500),
  explanation:z.string().min(1).max(400),ambiguity:z.enum(['none','needs_selection'])
}).strict();
export const AIPlanSchema=z.object({edits:z.array(AIEditSchema).max(5)}).strict();
export type AIPlan=z.infer<typeof AIPlanSchema>;
export const AIRequestSchema=z.object({
  instruction:z.string().trim().min(3).max(1200),
  blocks:z.array(z.object({id:z.string().max(60),page:z.number().int().min(1).max(80),text:z.string().max(1500)}).strict()).min(1).max(50),
  turnstileToken:z.string().max(2048)
}).strict().superRefine((value,ctx)=>{if(value.blocks.reduce((n,b)=>n+b.text.length,0)>12000)ctx.addIssue({code:'custom',message:'Text context is too large.'});});
export const planJSONSchema={type:'object',additionalProperties:false,required:['edits'],properties:{edits:{type:'array',maxItems:5,items:{type:'object',additionalProperties:false,required:['id','operation','page','blockId','original','replacement','explanation','ambiguity'],properties:{id:{type:'string'},operation:{type:'string',enum:['replace']},page:{type:'integer'},blockId:{type:'string'},original:{type:'string'},replacement:{type:'string'},explanation:{type:'string'},ambiguity:{type:'string',enum:['none','needs_selection']}}}}}};
