export interface SimilarIncidentContext {
  title: string;
  description: string;
  resolutionNotes: string[]; // messages from 'note'/'resolved' IncidentEvents
}

export interface TimelineEventContext {
  type: string;
  message: string | null;
  timestamp: string;
}

export interface GenerationProvider {
  summarize(newIncident: { title: string; description: string }, similar: SimilarIncidentContext[]): Promise<string>;
  draftPostmortem(
    incident: { title: string; description: string },
    events: TimelineEventContext[]
  ): Promise<string>;
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

  async draftPostmortem(
    incident: { title: string; description: string },
    events: TimelineEventContext[]
  ): Promise<string> {
    const timeline = events
      .map((e) => `[${e.timestamp}] ${e.type}${e.message ? `: ${e.message}` : ""}`)
      .join("\n");

    const prompt = `Write a brief blameless postmortem for the incident below, using ONLY the timeline provided — do not invent details, root causes, or fixes that aren't reflected in the events. Structure it with three short sections: "Summary", "Timeline", and "Root cause & follow-ups" (if the timeline doesn't clearly indicate a root cause or fix, say so plainly rather than guessing).

Incident: "${incident.title}"
Description: ${incident.description}

Timeline:
${timeline}`;

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

    const postmortemData = await res.json();
    const postmortemText = postmortemData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof postmortemText !== "string") {
      throw new Error("Gemini generation response missing candidates[0].content.parts[0].text");
    }
    return postmortemText.trim();
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

  async draftPostmortem(
    incident: { title: string; description: string },
    events: TimelineEventContext[]
  ): Promise<string> {
    const notes = events.filter((e) => e.type === "note" && e.message).map((e) => e.message as string);
    const fired = events.find((e) => e.type === "fired");
    const resolved = events.find((e) => e.type === "resolved");
    const durationText =
      fired && resolved
        ? `${Math.round((new Date(resolved.timestamp).getTime() - new Date(fired.timestamp).getTime()) / 60000)} minutes`
        : "unknown duration";

    return [
      "[Mock AI postmortem]",
      "",
      "## Summary",
      `"${incident.title}" was open for approximately ${durationText}, based on the recorded timeline.`,
      "",
      "## Timeline",
      events.map((e) => `- ${e.type}${e.message ? `: ${e.message}` : ""} (${e.timestamp})`).join("\n"),
      "",
      "## Root cause & follow-ups",
      notes.length > 0
        ? `Based on recorded notes: ${notes.join("; ")}.`
        : "No resolution notes were recorded on this incident, so a root cause can't be determined from the timeline alone.",
    ].join("\n");
  }
}
