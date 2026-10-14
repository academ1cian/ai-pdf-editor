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
    fieldType: z.enum(['rate','quantity','charge','subtotal','total','number','text']).optional(),
    label: z.string().max(100).optional(),
    calculation: z.object({ operation: z.enum(['sum','product']), sources: z.array(z.object({ blockId: z.string().max(60), page: z.number().int().min(1).max(80), original: z.string().max(100) }).strict()).min(2).max(20) }).strict().nullable().optional(),
  })
  .strict();
export const AIPlanSchema = z.object({ edits: z.array(AIEditSchema).max(8), clarification: z.string().max(500).optional() }).strict();
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
            field: z.object({ type: z.enum(['rate','quantity','charge','subtotal','total','number','text']), label:z.string().max(100),row:z.string().max(60),column:z.string().max(100) }).strict().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    turnstileToken: z.string().max(2048),
    sessionId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.blocks.reduce((n, b) => n + b.text.length, 0) > 12000)
      ctx.addIssue({ code: 'custom', message: 'Text context is too large.' });
  });
export const planJSONSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['edits','clarification'],
  properties: {
    clarification: { type:'string' },
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
          fieldType: {type:'string',enum:['rate','quantity','charge','subtotal','total','number','text']},
          label:{type:'string'},
          calculation:{anyOf:[{type:'null'},{type:'object',additionalProperties:false,required:['operation','sources'],properties:{operation:{type:'string',enum:['sum','product']},sources:{type:'array',minItems:2,maxItems:20,items:{type:'object',additionalProperties:false,required:['blockId','page','original'],properties:{blockId:{type:'string'},page:{type:'integer'},original:{type:'string'}}}}}}]},
        },
      },
    },
  },
};
