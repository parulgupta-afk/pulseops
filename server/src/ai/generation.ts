export interface SimilarIncidentContext {
  title: string;
  description: string;
  resolutionNotes: string[]; // messages from 'note'/'resolved' IncidentEvents
}

export interface GenerationProvider {
  summarize(newIncident: { title: string; description: string }, similar: SimilarIncidentContext[]): Promise<string>;
}

export class GeminiGenerationProvider implements GenerationProvider {
  constructor(
    private apiKey: string,
    private model: string = process.env.GEMINI_GENERATION_MODEL || "gemini-2.0-flash"
  ) {}

  async summarize(
    newIncident: { title: string; description: string },
    similar: SimilarIncidentContext[]
  ): Promise<string> {
    // Grounding is the whole point of RAG: the prompt explicitly instructs
    // the model to only use the retrieved incidents, and the caller (see
    // worker.ts) separately stores which incidents were retrieved so the UI
    // can cite them — the model isn't trusted to invent that list itself.
    const context = similar
      .map(
        (s, i) =>
          `Past incident ${i + 1}: "${s.title}"\nDescription: ${s.description}\nResolution notes: ${
            s.resolutionNotes.length > 0 ? s.resolutionNotes.join(" | ") : "(none recorded)"
          }`
      )
      .join("\n\n");

    const prompt = `You are assisting an on-call engineer triaging a new incident. Using ONLY the past incidents provided below (do not invent information not present here), write a brief (3-4 sentence) summary suggesting what might be going on and, if the past incidents' resolution notes suggest a fix, what to try. If the past incidents don't seem genuinely related, say so plainly instead of forcing a connection.

New incident: "${newIncident.title}"
Description: ${newIncident.description}

${context}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini generation request failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("Gemini generation response missing candidates[0].content.parts[0].text");
    }
    return text.trim();
  }
}

// Template-based, no API key needed. Deliberately labeled as a mock in its
// own output so it's never mistaken for a real AI-generated summary during a demo.
export class MockGenerationProvider implements GenerationProvider {
  async summarize(
    newIncident: { title: string; description: string },
    similar: SimilarIncidentContext[]
  ): Promise<string> {
    if (similar.length === 0) {
      return "[Mock AI summary] No sufficiently similar past incidents were found to ground a suggestion.";
    }
    const titles = similar.map((s) => `"${s.title}"`).join(", ");
    const notes = similar.flatMap((s) => s.resolutionNotes).slice(0, 2);
    const notesText =
      notes.length > 0
        ? ` Past resolution notes mentioned: ${notes.join("; ")}.`
        : " No resolution notes were recorded on those incidents.";
    return `[Mock AI summary] "${newIncident.title}" resembles ${similar.length} past incident(s): ${titles}.${notesText} Review their event timelines for the exact steps taken.`;
  }
}
