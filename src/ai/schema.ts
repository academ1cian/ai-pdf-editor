import { z } from 'zod';
export const AIEditSchema = z
  .object({
    id: z.string().min(1).max(80),
    operation: z.literal('replace'),
    page: z.number().int().min(1).max(80),
    blockId: z.string().min(1).max(60),
    original: z.string().min(1).max(500),
    replacement: z.string().max(500),
    explanation: z.string().min(1).max(400),
    ambiguity: z.enum(['none', 'needs_selection']),
    fieldType: z.enum(['rate','quantity','weight','charge','fee','subtotal','total','date','invoice_id','number','text']).optional(),
    label: z.string().max(100).optional(),
    calculation: z.object({ operation: z.enum(['sum','product']), sources: z.array(z.object({ blockId: z.string().max(60), page: z.number().int().min(1).max(80), original: z.string().max(100) }).strict()).min(1).max(20) }).strict().nullable().optional(),
  })
  .strict();
export const AIPlanSchema = z.object({ edits: z.array(AIEditSchema).max(8), clarification: z.string().max(500).optional(), interpretation:z.string().max(600).optional(), alternatives:z.array(z.object({label:z.string().max(100),instruction:z.string().max(1200)}).strict()).max(2).optional() }).strict();
export type AIPlan = z.infer<typeof AIPlanSchema>;
export const AIRequestSchema = z
  .object({
    instruction: z.string().trim().min(3).max(1200),
    blocks: z
      .array(
        z
          .object({
            id: z.string().max(60),
            page: z.number().int().min(1).max(80),
            text: z.string().max(1500),
            rect: z.tuple([z.number(),z.number(),z.number(),z.number()]).optional(),
            order: z.number().int().min(0).optional(),
            complete: z.boolean().optional(),
            lineId:z.string().max(60).optional(),start:z.number().int().min(0).optional(),end:z.number().int().min(1).optional(),font:z.string().max(100).optional(),baseline:z.number().optional(),size:z.number().min(1).max(500).optional(),format:z.string().max(20).optional(),
            field: z.object({ type: z.enum(['rate','quantity','weight','charge','fee','subtotal','total','date','invoice_id','number','text']), label:z.string().max(100),row:z.string().max(60),column:z.string().max(100),role:z.enum(['line_item','fee','summary','unknown']).optional(),description:z.string().max(140).optional() }).strict().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    turnstileToken: z.string().max(2048),
    sessionId: z.string().uuid().optional(),
    requestId:z.string().uuid().optional(),
    pending:z.array(z.object({original:z.string().max(500),replacement:z.string().max(2000),page:z.number().int().min(1).max(80)}).strict()).max(40).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.blocks.reduce((n, b) => n + b.text.length, 0) > 12000)
      ctx.addIssue({ code: 'custom', message: 'Text context is too large.' });
  });
export const planJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['edits','clarification','interpretation','alternatives'],
  properties: {
    clarification: { type:'string' },
    interpretation:{type:'string'},
    alternatives:{type:'array',maxItems:2,items:{type:'object',additionalProperties:false,required:['label','instruction'],properties:{label:{type:'string'},instruction:{type:'string'}}}},
    edits: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'operation',
          'page',
          'blockId',
          'original',
          'replacement',
          'explanation',
          'ambiguity', 'fieldType', 'label', 'calculation',
        ],
        properties: {
          id: { type: 'string' },
          operation: { type: 'string', enum: ['replace'] },
          page: { type: 'integer' },
          blockId: { type: 'string' },
          original: { type: 'string' },
          replacement: { type: 'string' },
          explanation: { type: 'string' },
          ambiguity: { type: 'string', enum: ['none', 'needs_selection'] },
          fieldType: {type:'string',enum:['rate','quantity','weight','charge','fee','subtotal','total','date','invoice_id','number','text']},
          label:{type:'string'},
          calculation:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['operation','sources'],properties:{operation:{type:'string',enum:['sum','product']},sources:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,required:['blockId','page','original'],properties:{blockId:{type:'string'},page:{type:'integer'},original:{type:'string'}}}}}}]},
        },
      },
    },
  },
};
