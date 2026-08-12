export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

const EMBEDDING_DIM = 768; // matches vector(768) on incidents.embedding_vector

// Calls Gemini's embedding model directly over REST rather than pulling in
// the @google/genai SDK — one fewer dependency to version-pin, and the API
// surface we need here is small enough that a raw fetch is simpler to reason
// about. Model name is configurable since Google does deprecate/replace
// embedding models over time; check https://ai.google.dev/gemini-api/docs/models
// if this starts 404ing.
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private apiKey: string,
    private model: string = process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004"
  ) {}

  async embed(text: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini embedding request failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    const values = data?.embedding?.values;
    if (!Array.isArray(values)) {
      throw new Error("Gemini embedding response missing embedding.values");
    }
    return values;
  }
}

// Deterministic bag-of-words hashing embedding — no API key required, so the
// whole RAG pipeline (embed → store → similarity search → generate) is
// demoable and testable end-to-end without Gemini access. It's not a real
// semantic embedding, but incidents sharing vocabulary do end up closer in
// cosine distance than unrelated ones, which is enough to prove the
// mechanism works before wiring in the real model.
export class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const vec = new Array(EMBEDDING_DIM).fill(0);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
    for (const word of words) {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
      }
      vec[hash % EMBEDDING_DIM] += 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}
