export interface FimTemplate {
  id: string;
  render(prefix: string, suffix: string): string;
  stop: string[];
}

/**
 * Fill-in-middle prompt formats by model family. Wrong template = garbage
 * output, so detection errs toward chat fallback when unsure.
 */
export const fimTemplates: readonly FimTemplate[] = [
  {
    id: 'qwen',
    render: (p, s) => `<|fim_prefix|>${p}<|fim_suffix|>${s}<|fim_middle|>`,
    stop: ['<|endoftext|>', '<|fim_prefix|>', '<|repo_name|>', '<|file_sep|>'],
  },
  {
    id: 'codegemma',
    render: (p, s) => `<|fim_prefix|>${p}<|fim_suffix|>${s}<|fim_middle|>`,
    stop: ['<|file_separator|>', '<|fim_prefix|>', '<end_of_turn>'],
  },
  {
    id: 'deepseek',
    render: (p, s) => `<｜fim▁begin｜>${p}<｜fim▁hole｜>${s}<｜fim▁end｜>`,
    stop: ['<｜end▁of▁sentence｜>'],
  },
  {
    id: 'starcoder',
    render: (p, s) => `<fim_prefix>${p}<fim_suffix>${s}<fim_middle>`,
    stop: ['<|endoftext|>', '<fim_prefix>', '<file_sep>'],
  },
  {
    id: 'codellama',
    render: (p, s) => `<PRE> ${p} <SUF>${s} <MID>`,
    stop: ['<EOT>', ' <EOT>', '<PRE>'],
  },
  {
    id: 'codestral',
    render: (p, s) => `[SUFFIX]${s}[PREFIX]${p}`,
    stop: ['[PREFIX]', '[SUFFIX]', '</s>'],
  },
];

const MODEL_PATTERNS: Array<[RegExp, string]> = [
  [/qwen/i, 'qwen'],
  [/codegemma/i, 'codegemma'],
  [/deepseek/i, 'deepseek'],
  [/starcoder|star-coder|granite|stable-?code/i, 'starcoder'],
  [/code-?llama/i, 'codellama'],
  [/codestral|mistral/i, 'codestral'],
];

export function getFimTemplate(id: string): FimTemplate | undefined {
  return fimTemplates.find((t) => t.id === id);
}

/** Pick the FIM template for a model id, or undefined → use chat fallback. */
export function detectFimTemplate(modelId: string): FimTemplate | undefined {
  for (const [pattern, id] of MODEL_PATTERNS) {
    if (pattern.test(modelId)) return getFimTemplate(id);
  }
  return undefined;
}
