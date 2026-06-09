import 'dotenv/config';

/** Centralised runtime config. The API key is read from the environment only. */
export const ENV = {
  port: Number(process.env.PORT ?? 8787),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  /** Default to a capable, cost-effective model; override via env. */
  model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 8192),
  dbPath: process.env.DB_PATH ?? './commander-oracle.sqlite',
};

export function hasApiKey(): boolean {
  return ENV.anthropicApiKey.length > 0;
}
