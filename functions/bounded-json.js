export async function readBoundedJson(request, maxBytes) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { error: "request_too_large" };
  }
  if (!request.body) return { error: "invalid_request" };

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try { await reader.cancel("Request body too large"); } catch {}
        return { error: "request_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { error: "invalid_request" };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { error: "invalid_request" };
  }
}
