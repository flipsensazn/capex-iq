import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as capexIntel } from "../functions/capex-intel.js";
import { onRequest as muskIntel } from "../functions/musk-intel.js";
import { onRequest as roboticsIntel } from "../functions/robotics-intel.js";
import siteWorker, { OperationCoordinator } from "../workers/site/index.js";

const SIX_HOURS = 6 * 60 * 60 * 1000;

const INTEL_HANDLERS = [
  { kind: "capex", cacheKey: "capexIntel", handler: capexIntel },
  { kind: "musk", cacheKey: "muskIntel", handler: muskIntel },
  { kind: "robotics", cacheKey: "roboticsIntel", handler: roboticsIntel },
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonRequest(pathname, body) {
  return new Request(`https://capex-iq.us${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function kvWith(valueByKey = {}) {
  const values = new Map(
    Object.entries(valueByKey).map(([key, value]) => [key, JSON.stringify(value)])
  );
  return {
    values,
    async get(key, type) {
      const value = values.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function coordinatorBinding(fetchStub, calls = []) {
  return {
    calls,
    getByName(name) {
      return {
        async fetch(request) {
          calls.push({
            name,
            pathname: new URL(request.url).pathname,
            body: await request.json(),
          });
          return fetchStub(request, name);
        },
      };
    },
  };
}

function fakeDurableObjectState() {
  const sqlCalls = [];
  const values = new Map();
  let alarm = null;
  let ready = Promise.resolve();
  const state = {
    storage: {
      sql: {
        exec(query, ...params) {
          sqlCalls.push({ query, params });
          return { toArray: () => [] };
        },
      },
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, value); },
      async delete(key) { values.delete(key); },
      async getAlarm() { return alarm; },
      async setAlarm(timestamp) { alarm = timestamp; },
    },
    blockConcurrencyWhile(callback) {
      ready = Promise.resolve().then(callback);
      return ready;
    },
  };
  return { state, sqlCalls, values, alarm: () => alarm, ready: () => ready };
}

for (const { kind, cacheKey, handler } of INTEL_HANDLERS) {
  test(`GET /${kind}-intel returns a fresh cache entry without coordinating`, async () => {
    const cached = { fetchedAt: Date.now(), marker: `${kind}-fresh` };
    const binding = coordinatorBinding(() => {
      throw new Error("fresh cache unexpectedly contacted coordinator");
    });

    const response = await handler({
      request: new Request(`https://capex-iq.us/${kind}-intel`),
      env: {
        SHARED_DATA: kvWith({ [cacheKey]: cached }),
        OPERATION_COORDINATOR: binding,
      },
      waitUntil() {
        throw new Error("fresh cache unexpectedly scheduled background work");
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...cached, fromCache: true });
    assert.equal(binding.calls.length, 0);
  });

  test(`GET /${kind}-intel serves stale data and coordinates refresh with waitUntil`, async () => {
    const cached = { fetchedAt: Date.now() - SIX_HOURS - 1, marker: `${kind}-stale` };
    const binding = coordinatorBinding(() => Response.json(
      { success: true, scheduled: true },
      { status: 202 }
    ));
    const background = [];

    const response = await handler({
      request: new Request(`https://capex-iq.us/${kind}-intel`),
      env: {
        SHARED_DATA: kvWith({ [cacheKey]: cached }),
        OPERATION_COORDINATOR: binding,
      },
      waitUntil(promise) {
        background.push(promise);
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...cached,
      fromCache: true,
      stale: true,
    });
    assert.deepEqual(binding.calls, [{
      name: `intel:${kind}`,
      pathname: "/intel-refresh-background",
      body: { kind },
    }]);
    assert.equal(background.length, 1);
    await background[0];
  });

  test(`GET /${kind}-intel awaits a coordinated refresh when cache is missing`, async () => {
    const refreshed = { fetchedAt: Date.now(), marker: `${kind}-refreshed` };
    const binding = coordinatorBinding(() => Response.json({
      success: true,
      result: refreshed,
    }));

    const response = await handler({
      request: new Request(`https://capex-iq.us/${kind}-intel`),
      env: {
        SHARED_DATA: kvWith(),
        OPERATION_COORDINATOR: binding,
      },
      waitUntil() {},
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...refreshed, fromCache: false });
    assert.deepEqual(binding.calls, [{
      name: `intel:${kind}`,
      pathname: "/intel-refresh",
      body: { kind },
    }]);
  });
}

test("an intel cache miss fails closed without the coordinator binding", async () => {
  const response = await capexIntel({
    request: new Request("https://capex-iq.us/capex-intel"),
    env: { SHARED_DATA: kvWith() },
    waitUntil() {},
  });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "Intel refresh is temporarily unavailable");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("admin intel POST coordinates cache invalidation and preserves its response", async () => {
  for (const { kind, handler } of INTEL_HANDLERS) {
    const binding = coordinatorBinding(() => Response.json({ success: true }));
    const response = await handler({
      request: jsonRequest(`/${kind}-intel`, { password: "correct-password" }),
      env: {
        ADMIN_PASSWORD: "correct-password",
        OPERATION_COORDINATOR: binding,
      },
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    assert.deepEqual(binding.calls, [{
      name: `intel:${kind}`,
      pathname: "/intel-invalidate",
      body: { kind },
    }]);
  }
});

test("OperationCoordinator coalesces concurrent refreshes for one intel instance", async () => {
  const cacheRead = deferred();
  const cacheReadStarted = deferred();
  let getCalls = 0;
  const cached = { fetchedAt: Date.now(), marker: "coalesced" };
  const { state, sqlCalls, ready } = fakeDurableObjectState();
  const coordinator = new OperationCoordinator(state, {
    SHARED_DATA: {
      async get() {
        getCalls += 1;
        cacheReadStarted.resolve();
        return cacheRead.promise;
      },
    },
  });
  await ready();

  const first = coordinator.fetch(jsonRequest("/intel-refresh", {
    kind: "capex",
  }));
  const second = coordinator.fetch(jsonRequest("/intel-refresh", {
    kind: "capex",
  }));

  await cacheReadStarted.promise;
  assert.equal(getCalls, 1);
  cacheRead.resolve(cached);

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual((await firstResponse.json()).result, cached);
  assert.deepEqual((await secondResponse.json()).result, cached);
  assert.equal(getCalls, 1);
  assert.equal(sqlCalls.filter(call => call.params[1] === "running").length, 1);
  assert.equal(sqlCalls.filter(call => call.params[1] === "success").length, 1);
});

test("OperationCoordinator queues a forced refresh behind weaker in-flight work", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const observed = [];
  const { state, ready } = fakeDurableObjectState();
  const coordinator = new OperationCoordinator(state, {});
  coordinator.refreshIntel = async (kind, { force }) => {
    observed.push({ kind, force });
    if (!force) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    return { kind, force };
  };
  await ready();

  const ordinary = coordinator.coalescedIntelRefresh("capex");
  await firstStarted.promise;
  const forced = coordinator.coalescedIntelRefresh("capex", { force: true });
  releaseFirst.resolve();

  assert.deepEqual(await ordinary, { kind: "capex", force: false });
  assert.deepEqual(await forced, { kind: "capex", force: true });
  assert.deepEqual(observed, [
    { kind: "capex", force: false },
    { kind: "capex", force: true },
  ]);
});

test("OperationCoordinator schedules stale refreshes on a durable alarm", async () => {
  const cached = { fetchedAt: Date.now(), marker: "alarm-refresh" };
  let cacheReads = 0;
  const { state, values, alarm, ready } = fakeDurableObjectState();
  const coordinator = new OperationCoordinator(state, {
    SHARED_DATA: {
      async get() {
        cacheReads += 1;
        return cached;
      },
    },
  });
  await ready();

  const scheduled = await coordinator.fetch(jsonRequest("/intel-refresh-background", {
    kind: "capex",
  }));
  assert.equal(scheduled.status, 202);
  assert.deepEqual(await scheduled.json(), { success: true, scheduled: true });
  assert.notEqual(alarm(), null);
  assert.deepEqual(values.get("pendingIntelRefresh"), { kind: "capex" });

  await coordinator.alarm();
  assert.equal(cacheReads, 1);
  assert.equal(values.has("pendingIntelRefresh"), false);
});

test("OperationCoordinator serializes KV registration writes and mirrors successes", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const firstMemberRead = deferred();
  const firstMemberReadStarted = deferred();
  const { state, sqlCalls, ready } = fakeDurableObjectState();
  const sharedData = kvWith();
  const originalGet = sharedData.get.bind(sharedData);
  const memberWrites = [];
  let memberReads = 0;
  sharedData.get = async (key, type) => {
    memberReads += 1;
    if (memberReads === 1) {
      firstMemberReadStarted.resolve();
      await firstMemberRead.promise;
    }
    return originalGet(key, type);
  };
  const originalPut = sharedData.put.bind(sharedData);
  sharedData.put = async (key, value) => {
    memberWrites.push({ key, value: JSON.parse(value) });
    await originalPut(key, value);
  };
  const coordinator = new OperationCoordinator(state, {
    SHARED_DATA: sharedData,
  });
  const cloudflareApiCalls = [];

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (new URL(url).hostname === "api.cloudflare.com") cloudflareApiCalls.push(url);
    throw new Error(`Unexpected external fetch: ${url}`);
  };

  try {
    await ready();
    const first = coordinator.fetch(jsonRequest("/register-member", {
      email: "First@Example.com",
    }));
    const second = coordinator.fetch(jsonRequest("/register-member", {
      email: "second@example.com",
    }));

    await firstMemberReadStarted.promise;
    assert.equal(memberReads, 1, "second mutation must wait for the first");
    firstMemberRead.resolve();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    const freshResult = {
      success: true,
      already: false,
      message: "You're on the list! The free dashboard is open — membership unlocks the full signal stack.",
    };
    assert.deepEqual(await firstResponse.json(), freshResult);
    assert.deepEqual(await secondResponse.json(), freshResult);
    assert.equal(memberReads, 2);
    assert.equal(memberWrites.length, 2);
    assert.deepEqual(memberWrites.map(write => write.key), [
      "member:first@example.com",
      "member:second@example.com",
    ]);
    for (const { value } of memberWrites) {
      assert.deepEqual(value.features, {});
      assert.equal(value.source, "self-register");
      assert.equal(new Date(value.registeredAt).toISOString(), value.registeredAt);
    }
    assert.equal(cloudflareApiCalls.length, 0, "registration must not call api.cloudflare.com");

    const mirroredEmails = sqlCalls
      .filter(call => call.query.includes("INSERT INTO members"))
      .map(call => call.params[0]);
    assert.deepEqual(mirroredEmails, ["first@example.com", "second@example.com"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OperationCoordinator returns already without overwriting granted member features", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const grantedRecord = {
    features: { research: true, radar: true },
    registeredAt: "2026-08-01T12:00:00.000Z",
    source: "owner-grant",
  };
  const memberKey = "member:granted@example.com";
  const sharedData = kvWith({ [memberKey]: grantedRecord });
  const originalRecord = sharedData.values.get(memberKey);
  const originalPut = sharedData.put.bind(sharedData);
  let putCalls = 0;
  sharedData.put = async (...args) => {
    putCalls += 1;
    return originalPut(...args);
  };
  const { state, sqlCalls, ready } = fakeDurableObjectState();
  const coordinator = new OperationCoordinator(state, { SHARED_DATA: sharedData });
  const cloudflareApiCalls = [];

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (new URL(url).hostname === "api.cloudflare.com") cloudflareApiCalls.push(url);
    throw new Error(`Unexpected external fetch: ${url}`);
  };

  try {
    await ready();
    const response = await coordinator.fetch(jsonRequest("/register-member", {
      email: "Granted@Example.com",
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      already: true,
      message: "You're already on the list — the free dashboard is open to everyone.",
    });
    assert.equal(
      sharedData.values.get(memberKey),
      originalRecord,
      "re-registering must not overwrite a granted member record"
    );
    assert.equal(putCalls, 0, "re-registering must not write an existing member record");
    assert.deepEqual(JSON.parse(sharedData.values.get(memberKey)), grantedRecord);
    assert.equal(cloudflareApiCalls.length, 0, "registration must not call api.cloudflare.com");

    const memberInsert = sqlCalls.find(call => call.query.includes("INSERT INTO members"));
    assert.equal(memberInsert.params[0], "granted@example.com");
    assert.equal(memberInsert.params[3], 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OperationCoordinator rejects registration when SHARED_DATA is unconfigured", async () => {
  const { state, sqlCalls, ready } = fakeDurableObjectState();
  const coordinator = new OperationCoordinator(state, {});
  await ready();

  const response = await coordinator.fetch(jsonRequest("/register-member", {
    email: "member@example.com",
  }));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    code: "registration_unavailable",
    message: "Registration isn't open yet — check back soon.",
  });
  assert.equal(sqlCalls.some(call => call.query.includes("INSERT INTO members")), false);
});

test("scheduled handler prewarms all three intel coordinator instances", async () => {
  const binding = coordinatorBinding((_request, name) => Response.json({
    success: true,
    result: { marker: name },
  }));
  const scheduledWork = [];

  siteWorker.scheduled({}, { OPERATION_COORDINATOR: binding }, {
    waitUntil(promise) {
      scheduledWork.push(promise);
    },
  });

  assert.equal(scheduledWork.length, 1);
  await scheduledWork[0];
  assert.deepEqual(
    binding.calls.map(call => call.name).sort(),
    ["intel:capex", "intel:musk", "intel:robotics"]
  );
  for (const call of binding.calls) {
    assert.equal(call.pathname, "/intel-refresh");
    assert.deepEqual(call.body, {
      kind: call.name.slice("intel:".length),
      force: true,
    });
  }
});

test("scheduled handler still attempts every intel feed when one prewarm fails", async () => {
  const binding = coordinatorBinding((_request, name) => name === "intel:capex"
    ? Response.json({ error: "capex unavailable" }, { status: 503 })
    : Response.json({ success: true, result: { marker: name } }));
  const scheduledWork = [];

  siteWorker.scheduled({}, { OPERATION_COORDINATOR: binding }, {
    waitUntil(promise) {
      scheduledWork.push(promise);
    },
  });

  await assert.rejects(scheduledWork[0], /1 intel prewarm operation/);
  assert.deepEqual(
    binding.calls.map(call => call.name),
    ["intel:capex", "intel:musk", "intel:robotics"]
  );
});
