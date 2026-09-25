export async function parseForm(request) {
  if (request.parsedForm) return request.parsedForm;
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  request.parsedForm = String(request.headers["content-type"] || "").includes("application/json")
    ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw).entries());
  return request.parsedForm;
}
