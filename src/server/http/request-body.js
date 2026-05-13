export async function parseForm(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}
