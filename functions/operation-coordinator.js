const COORDINATOR_ORIGIN = "https://operation-coordinator";

export class IntelRefreshError extends Error {
  constructor(status, payload, { noStore = false } = {}) {
    super(payload?.error || "Intel refresh failed");
    this.name = "IntelRefreshError";
    this.status = status;
    this.payload = payload;
    this.noStore = noStore;
  }
}

async function callCoordinator(env, instanceName, pathname, body) {
  if (typeof env.OPERATION_COORDINATOR?.getByName !== "function") {
    throw new IntelRefreshError(503, {
      error: "Intel refresh is temporarily unavailable",
    }, { noStore: true });
  }

  let response;
  try {
    const stub = env.OPERATION_COORDINATOR.getByName(instanceName);
    response = await stub.fetch(new Request(`${COORDINATOR_ORIGIN}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  } catch {
    throw new IntelRefreshError(503, {
      error: "Intel refresh is temporarily unavailable",
    }, { noStore: true });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new IntelRefreshError(response.ok ? 502 : response.status, {
      error: "Operation coordinator returned an invalid response",
    }, { noStore: true });
  }

  if (!response.ok) {
    throw new IntelRefreshError(response.status, payload, {
      noStore: response.headers.get("Cache-Control") === "no-store",
    });
  }
  return payload;
}

export async function refreshIntelCoordinated(
  env,
  kind,
  { force = false } = {}
) {
  const coordinated = await callCoordinator(
    env,
    `intel:${kind}`,
    "/intel-refresh",
    { kind, ...(force ? { force: true } : {}) }
  );
  if (coordinated?.success !== true || !coordinated.result || typeof coordinated.result !== "object") {
    throw new IntelRefreshError(502, {
      error: "Operation coordinator returned an invalid response",
    }, { noStore: true });
  }
  return coordinated.result;
}

export async function scheduleIntelRefreshCoordinated(env, kind) {
  const coordinated = await callCoordinator(
    env,
    `intel:${kind}`,
    "/intel-refresh-background",
    { kind }
  );
  if (coordinated?.success !== true) {
    throw new IntelRefreshError(502, {
      error: "Operation coordinator returned an invalid response",
    }, { noStore: true });
  }
  return coordinated;
}

export async function invalidateIntelCoordinated(env, kind) {
  const coordinated = await callCoordinator(
    env,
    `intel:${kind}`,
    "/intel-invalidate",
    { kind }
  );
  if (coordinated?.success !== true) {
    throw new IntelRefreshError(502, {
      error: "Operation coordinator returned an invalid response",
    }, { noStore: true });
  }
  return coordinated;
}

export function refreshIntelInBackground(context, env, kind) {
  const work = scheduleIntelRefreshCoordinated(env, kind).catch(error => {
    console.error(JSON.stringify({
      message: "intel background refresh failed",
      kind,
      error: error instanceof Error ? error.message : String(error),
    }));
  });

  if (typeof context.waitUntil === "function") {
    context.waitUntil(work);
  } else {
    // The production Worker and Pages contexts both provide waitUntil. This
    // fallback keeps direct Node callers non-blocking without a floating
    // rejection.
    void work;
  }
}

export function intelErrorResponse(error, headers) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const payload = error?.payload || {
    error: error instanceof Error ? error.message : "Intel refresh failed",
  };
  return new Response(JSON.stringify(payload), {
    status,
    headers: error?.noStore
      ? { ...headers, "Cache-Control": "no-store" }
      : headers,
  });
}
