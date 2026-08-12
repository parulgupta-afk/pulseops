// pgvector expects its literal format as a bracketed, comma-separated string
// (e.g. "[0.1,0.2,0.3]") cast to ::vector — the node-postgres driver has no
// native understanding of the vector type, so this is how a plain number[]
// gets sent through a parameterized query.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
