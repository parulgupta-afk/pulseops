import { GeminiEmbeddingProvider, MockEmbeddingProvider, type EmbeddingProvider } from "./embeddings";
import { GeminiGenerationProvider, MockGenerationProvider, type GenerationProvider } from "./generation";

const apiKey = process.env.GEMINI_API_KEY?.trim();

export const embeddingProvider: EmbeddingProvider = apiKey
  ? new GeminiEmbeddingProvider(apiKey)
  : new MockEmbeddingProvider();

export const generationProvider: GenerationProvider = apiKey
  ? new GeminiGenerationProvider(apiKey)
  : new MockGenerationProvider();

if (!apiKey) {
  console.log(
    "[ai] No GEMINI_API_KEY set — using mock embedding/generation providers. " +
      "Get a free key at https://aistudio.google.com/apikey to use real Gemini."
  );
}

export * from "./embeddings";
export * from "./generation";
