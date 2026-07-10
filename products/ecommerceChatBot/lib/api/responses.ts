export function ok(data: unknown): Response {
  return Response.json(data, { status: 200 });
}

export function created(data: unknown): Response {
  return Response.json(data, { status: 201 });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { ETag: etag } });
}

export function badRequest(message: string, code?: string): Response {
  return Response.json(
    { error: message, ...(code ? { code } : {}) },
    { status: 400 },
  );
}

export function unauthorized(
  message = "Unauthorized",
  code?: string,
): Response {
  return Response.json(
    { error: message, ...(code ? { code } : {}) },
    { status: 401 },
  );
}

export function forbidden(message: string, code?: string): Response {
  return Response.json(
    { error: message, ...(code ? { code } : {}) },
    { status: 403 },
  );
}

export function notFound(message = "Not found"): Response {
  return Response.json({ error: message }, { status: 404 });
}

export function paymentRequired(message: string, code?: string): Response {
  return Response.json(
    { error: message, ...(code ? { code } : {}) },
    { status: 402 },
  );
}

export function tooManyRequests(
  retryAfterSeconds: number,
  message = "Too many requests. Please slow down.",
): Response {
  return Response.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

export function serviceUnavailable(
  message = "Service temporarily unavailable. Please try again shortly.",
): Response {
  return Response.json({ error: message }, { status: 503 });
}

export function serverError(message = "Something went wrong"): Response {
  return Response.json({ error: message }, { status: 500 });
}
