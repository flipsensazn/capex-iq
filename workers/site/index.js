// workers/site — the site Worker (Workers + static assets).
//
// This replaces the Cloudflare Pages deployment. The existing files in
// functions/ are unchanged Pages Functions — this router gives each one the
// same {request, env} context Pages did, keyed by its old file-based route.
// Anything that isn't an API route falls through to the static assets
// (the Vite build in dist/, single-page-application fallback).
//
// Deploy: npx vite build (repo root), then npx wrangler deploy (this dir).
// CI does exactly that on every merge to main (.github/workflows/deploy-site.yml).

import * as analyze        from "../../functions/analyze.js";
import * as candidates     from "../../functions/candidates.js";
import * as capexHistory   from "../../functions/capex-history.js";
import * as capexIntel     from "../../functions/capex-intel.js";
import * as capex          from "../../functions/capex.js";
import * as cnnFearGreed   from "../../functions/cnn-fear-greed.js";
import * as composite      from "../../functions/composite.js";
import * as exposure       from "../../functions/exposure.js";
import * as fundamentals   from "../../functions/fundamentals.js";
import * as gauges         from "../../functions/gauges.js";
import * as history        from "../../functions/history.js";
import * as marketNews     from "../../functions/market-news.js";
import * as me             from "../../functions/me.js";
import * as muskCapex      from "../../functions/musk-capex.js";
import * as muskIntel      from "../../functions/musk-intel.js";
import * as news           from "../../functions/news.js";
import * as presence       from "../../functions/presence.js";
import * as prices         from "../../functions/prices.js";
import * as quote          from "../../functions/quote.js";
import * as radar          from "../../functions/radar.js";
import * as register       from "../../functions/register.js";
import * as research       from "../../functions/research.js";
import * as roboticsCapex  from "../../functions/robotics-capex.js";
import * as roboticsIntel  from "../../functions/robotics-intel.js";
import * as scoreboard     from "../../functions/scoreboard.js";
import * as shortlist      from "../../functions/shortlist.js";
import * as stress         from "../../functions/stress.js";
import { refreshIntelCoordinated } from "../../functions/operation-coordinator.js";

const ROUTES = {
  "/analyze":         analyze,
  "/candidates":      candidates,
  "/capex-history":   capexHistory,
  "/capex-intel":     capexIntel,
  "/capex":           capex,
  "/cnn-fear-greed":  cnnFearGreed,
  "/composite":       composite,
  "/exposure":        exposure,
  "/fundamentals":    fundamentals,
  "/gauges":          gauges,
  "/history":         history,
  "/market-news":     marketNews,
  "/me":              me,
  "/musk-capex":      muskCapex,
  "/musk-intel":      muskIntel,
  "/news":            news,
  "/presence":        presence,
  "/prices":          prices,
  "/quote":           quote,
  "/radar":           radar,
  "/register":        register,
  "/research":        research,
  "/robotics-capex":  roboticsCapex,
  "/robotics-intel":  roboticsIntel,
  "/scoreboard":      scoreboard,
  "/shortlist":       shortlist,
  "/stress":          stress,
};

// Security headers live here because `_headers` is a Pages-only convention
// and is ignored by this Workers-with-static-assets deployment.
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const INTEL_OPERATIONS = {
  capex: {
    cacheKey: "capexIntel",
    refresh: capexIntel.refreshCapexIntel,
  },
  musk: {
    cacheKey: "muskIntel",
    refresh: muskIntel.refreshMuskIntel,
  },
  robotics: {
    cacheKey: "roboticsIntel",
    refresh: roboticsIntel.refreshRoboticsIntel,
  },
};
const PENDING_INTEL_REFRESH_KEY = "pendingIntelRefresh";

function coordinatorResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function coordinatorErrorResponse(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const body = error?.payload || (Number.isInteger(error?.status)
    ? {
        success: false,
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
      }
    : { error: "Operation failed" });

  console.error(JSON.stringify({
    message: "operation coordinator request failed",
    status,
    error: error instanceof Error ? error.message : String(error),
  }));
  return coordinatorResponse(
    body,
    status,
    error?.noStore ? { "Cache-Control": "no-store" } : {}
  );
}

// Plain fetch-style Durable Object class keeps this module importable by the
// existing Node test runner without importing cloudflare:workers.
export class OperationCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.operationTail = Promise.resolve();
    this.inFlightRefreshes = new Map();

    state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS members (
          email TEXT PRIMARY KEY COLLATE NOCASE,
          registered_at INTEGER NOT NULL,
          last_confirmed_at INTEGER NOT NULL,
          already_registered INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS operations (
          name TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          error_message TEXT
        );
      `);
    });
  }

  runSerialized(operation) {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  recordOperation(name, state, startedAt, error = null) {
    const finishedAt = state === "running" ? null : Date.now();
    this.state.storage.sql.exec(`
      INSERT INTO operations (name, state, started_at, finished_at, error_message)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        state = excluded.state,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        error_message = excluded.error_message
    `, name, state, startedAt, finishedAt, error ? String(error).slice(0, 1000) : null);
  }

  async registerMember(email) {
    const result = await register.registerMemberInAccess(this.env, email);
    const now = Date.now();
    this.state.storage.sql.exec(`
      INSERT INTO members (email, registered_at, last_confirmed_at, already_registered)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        last_confirmed_at = excluded.last_confirmed_at,
        already_registered = excluded.already_registered
    `, email, now, now, result.already ? 1 : 0);
    return result;
  }

  async refreshIntel(kind, { force = false } = {}) {
    const operation = INTEL_OPERATIONS[kind];
    if (!operation) {
      const error = new Error("Unknown intel operation");
      error.status = 400;
      throw error;
    }

    const startedAt = Date.now();
    this.recordOperation(`intel:${kind}`, "running", startedAt);
    try {
      const result = await operation.refresh(this.env, { force });
      this.recordOperation(`intel:${kind}`, "success", startedAt);
      return result;
    } catch (error) {
      this.recordOperation(`intel:${kind}`, "failure", startedAt, error?.message || error);
      throw error;
    }
  }

  coalescedIntelRefresh(kind, { force = false } = {}) {
    const existing = this.inFlightRefreshes.get(kind);
    if (existing && (!force || existing.force)) return existing.promise;

    const run = this.runSerialized(() => this.refreshIntel(kind, { force }));
    const entry = { promise: run, force };
    this.inFlightRefreshes.set(kind, entry);
    const clear = () => {
      if (this.inFlightRefreshes.get(kind) === entry) {
        this.inFlightRefreshes.delete(kind);
      }
    };
    void run.then(clear, clear);
    return run;
  }

  async scheduleIntelRefresh(kind) {
    if (!INTEL_OPERATIONS[kind]) {
      const error = new Error("Unknown intel operation");
      error.status = 400;
      throw error;
    }
    await this.state.storage.put(PENDING_INTEL_REFRESH_KEY, { kind });
    if (await this.state.storage.getAlarm() === null) {
      await this.state.storage.setAlarm(Date.now());
    }
  }

  async alarm() {
    const pending = await this.state.storage.get(PENDING_INTEL_REFRESH_KEY);
    if (!pending?.kind) return;
    await this.coalescedIntelRefresh(pending.kind);
    await this.state.storage.delete(PENDING_INTEL_REFRESH_KEY);
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return coordinatorResponse({ error: "Method Not Allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return coordinatorResponse({ error: "Invalid request" }, 400);
    }

    const pathname = new URL(request.url).pathname;
    try {
      if (pathname === "/register-member") {
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email || email.length > 254) {
          return coordinatorResponse({ success: false, message: "Invalid email." }, 400);
        }
        const result = await this.runSerialized(() => this.registerMember(email));
        return coordinatorResponse(result);
      }

      if (pathname === "/intel-refresh") {
        const result = await this.coalescedIntelRefresh(body.kind, {
          force: body.force === true,
        });
        return coordinatorResponse({ success: true, result });
      }

      if (pathname === "/intel-refresh-background") {
        await this.scheduleIntelRefresh(body.kind);
        return coordinatorResponse({ success: true, scheduled: true }, 202);
      }

      if (pathname === "/intel-invalidate") {
        const operation = INTEL_OPERATIONS[body.kind];
        if (!operation) return coordinatorResponse({ error: "Unknown intel operation" }, 400);
        await this.runSerialized(async () => {
          if (this.env.SHARED_DATA) await this.env.SHARED_DATA.delete(operation.cacheKey);
        });
        return coordinatorResponse({ success: true });
      }

      return coordinatorResponse({ error: "Not Found" }, 404);
    } catch (error) {
      return coordinatorErrorResponse(error);
    }
  }
}

async function prewarmIntel(env) {
  const results = [];
  const failures = [];
  for (const kind of Object.keys(INTEL_OPERATIONS)) {
    try {
      results.push(await refreshIntelCoordinated(env, kind, { force: true }));
    } catch (error) {
      failures.push(error);
      console.error(JSON.stringify({
        message: "scheduled intel prewarm failed",
        kind,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `${failures.length} intel prewarm operation(s) failed`);
  }
  return results;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // The dashboard lives at /app (Cloudflare Access protects this path at
    // the edge — see README). The built asset is app.html; rewrite so the
    // clean URL serves it.
    if (pathname === "/app" || pathname === "/app/") {
      const response = await env.ASSETS.fetch(new Request(`${url.origin}/app.html`, request));
      return withSecurityHeaders(response);
    }

    const route = ROUTES[pathname.replace(/\/$/, "") || "/"];
    if (route?.onRequest) {
      // Pages Functions context shim — every function here uses only
      // {request, env}; waitUntil included for safety.
      return route.onRequest({
        request,
        env,
        params: {},
        data: {},
        functionPath: pathname,
        waitUntil: ctx.waitUntil.bind(ctx),
        passThroughOnException: () => {},
        next: () => env.ASSETS.fetch(request),
      });
    }
    const response = await env.ASSETS.fetch(request);
    return withSecurityHeaders(response);
  },

  scheduled(_controller, env, ctx) {
    ctx.waitUntil(prewarmIntel(env));
  },
};
