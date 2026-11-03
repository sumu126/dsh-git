import z from '@deepseek-ai/schemastery'

export interface Config { a: string }

export const other: z<Config> = z.object({ a: z.string().default('') })
export type Inferred = z.infer<typeof other>
