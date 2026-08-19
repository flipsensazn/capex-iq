import { useCallback, useEffect, useRef, useState } from "react";

const INTEL_TIMEOUT_MS = 60_000;
export const DASHBOARD_HEALTH_REFRESH_MS = 5 * 60_000;

export function intelEndpointForView(view) {
  if (view === "ai") return "/capex-intel";
  if (view === "musk") return "/musk-intel";
  if (view === "robotics") return "/robotics-intel";
  return null;
}

export const DASHBOARD_DATASETS = Object.freeze({
  stress: { endpoint: "/stress", label: "Transcript stress" },
  gauges: { endpoint: "/gauges", label: "XBRL gauges" },
  exposure: { endpoint: "/exposure", label: "Customer exposure" },
  composite: { endpoint: "/composite", label: "Composite scores" },
});

function initialDatasetHealth() {
  return Object.fromEntries(Object.keys(DASHBOARD_DATASETS).map(key => [key, {
    loading: true,
    error: null,
    stale: null,
    asOf: null,
    state: "unknown",
    pipeline: null,
    runError: null,
    counts: null,
    coverage: null,
  }]));
}

export async function readJsonResponse(response, label = "Request") {
  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error(`${label} returned an invalid response`);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(
      payload?.message
      || payload?.detail
      || payload?.error
      || `${label} failed (${response.status})`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function isLockedAccessError(error, codes = ["members_only"]) {
  return error?.status === 401
    || (error?.status === 403 && codes.includes(error?.payload?.code));
}

export function normalizeDatasetHealth(health) {
  const states = new Set(["running", "success", "degraded", "failure"]);
  return {
    loading: false,
    error: null,
    stale: health?.stale !== false,
    asOf: health?.asOf ?? health?.dataFreshAt ?? null,
    state: states.has(health?.state) ? health.state : "unknown",
    pipeline: health?.pipeline ?? null,
    runError: health?.error ?? null,
    counts: health?.counts ?? null,
    coverage: health?.coverage ?? null,
    limitedRun: health?.limitedRun === true,
  };
}

export async function fetchDashboardDataset(endpoint, fetchImpl = fetch, init = {}) {
  const response = await fetchImpl(endpoint, init);
  let json;
  try {
    json = await readJsonResponse(response, endpoint);
  } catch (error) {
    if (isLockedAccessError(error)) return { locked: true };
    error.datasetHealth = normalizeDatasetHealth(error?.payload?.health);
    throw error;
  }
  if (!json?.success || !json.data || typeof json.data !== "object" || Array.isArray(json.data)) {
    const error = new Error(json?.message || `${endpoint} returned no usable data`);
    error.datasetHealth = normalizeDatasetHealth(json?.health);
    throw error;
  }
  return { data: json.data, health: normalizeDatasetHealth(json.health) };
}

export function startDashboardRefreshLoop({
  refresh,
  intervalMs = DASHBOARD_HEALTH_REFRESH_MS,
  documentImpl = globalThis.document,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  AbortControllerImpl = globalThis.AbortController,
}) {
  let stopped = false;
  let running = false;
  let controller = null;
  const run = async () => {
    if (stopped || running || documentImpl?.hidden) return;
    running = true;
    controller = new AbortControllerImpl();
    try {
      await refresh(controller.signal);
    } finally {
      controller = null;
      running = false;
    }
  };
  const trigger = () => {
    void run().catch(() => {});
  };
  const onVisibilityChange = () => {
    if (!documentImpl?.hidden) trigger();
  };
  const intervalId = setIntervalImpl(trigger, intervalMs);
  documentImpl?.addEventListener?.("visibilitychange", onVisibilityChange);
  trigger();

  return () => {
    stopped = true;
    controller?.abort();
    clearIntervalImpl(intervalId);
    documentImpl?.removeEventListener?.("visibilitychange", onVisibilityChange);
  };
}

function issueDescription(label, health) {
  if (health.locked) return null;
  const asOfDate = health.asOf ? String(health.asOf).slice(0, 10) : null;
  const asOf = asOfDate ? `, as of ${asOfDate}` : "";
  const limitedAttempt = health.limitedRun
    ? "; latest attempt covered only a limited smoke-test universe"
    : "";
  if (health.error) return `${label} unavailable`;
  if (health.loading) return `${label} loading`;
  if (health.state === "failure") {
    return `${label} refresh failed${asOfDate ? `; last good data ${asOfDate}` : ""}${limitedAttempt}`;
  }
  if (health.state === "degraded") return `${label} has degraded coverage${asOf}${limitedAttempt}`;
  if (health.state === "running") return `${label} refresh in progress${asOf}${limitedAttempt}`;
  if (health.state === "unknown") {
    return `${label} freshness unverified${asOf}${limitedAttempt}`;
  }
  if (health.limitedRun) {
    return `${label} last refresh covered only a limited smoke-test universe${asOfDate ? `; last full data ${asOfDate}` : ""}`;
  }
  if (health.stale) return `${label} stale${asOf}`;
  return null;
}

export function buildDashboardDataNotice(dataHealth) {
  const entries = Object.entries(DASHBOARD_DATASETS).map(([key, config]) => ({
    label: config.label,
    health: dataHealth?.[key] ?? initialDatasetHealth()[key],
  }));
  const loading = entries.filter(entry => entry.health.loading);
  const issues = entries
    .map(entry => issueDescription(entry.label, entry.health))
    .filter(Boolean);

  if (loading.length === entries.length) {
    return {
      type: "info",
      message: `Loading live supply-chain datasets: ${loading.map(entry => entry.label).join(", ")}.`,
    };
  }
  if (!issues.length) return null;
  return {
    type: "warning",
    message: `Partial/degraded data: ${issues.join("; ")}. Affected signals may be missing; displayed values are stored snapshots, not confirmed live.`,
  };
}

function mergePriceEntries(prev, incoming) {
  const HIST_KEYS = [
    "change5D",
    "change1M",
    "change6M",
    "changeYTD",
    "change1Y",
    "week52Low",
    "week52High",
    "earningsDate",
    "chartData",
    "chartTimestamps",
  ];

  const next = { ...prev };
  for (const [ticker, newVal] of Object.entries(incoming)) {
    if (!newVal || typeof newVal !== "object") {
      next[ticker] = newVal;
      continue;
    }
    const prevVal = prev[ticker];
    if (prevVal && typeof prevVal === "object") {
      const merged = { ...prevVal, ...newVal };
      for (const key of HIST_KEYS) {
        if ((newVal[key] === undefined || newVal[key] === null) && prevVal[key] != null) {
          merged[key] = prevVal[key];
        }
      }
      next[ticker] = merged;
    } else {
      next[ticker] = newVal;
    }
  }
  return next;
}

export function useDashboardData({
  activeView = "ai",
  defaultCapexData,
  defaultMuskData,
  defaultRoboticsData,
  indexTickers,
  cryptoTickers,
  hyperscalerTickers,
  pinnedTickers = [],
  fetchAllPrices,
  getAllTickers,
}) {
  const [shortList, setShortList] = useState([]);
  const [capexData, setCapexData] = useState(defaultCapexData);
  const [capexIntel, setCapexIntel] = useState(null);
  const [capexIntelStatus, setCapexIntelStatus] = useState("idle");
  const [capexIntelError, setCapexIntelError] = useState(null);
  const [capexHistory, setCapexHistory] = useState([]);
  const [stressData, setStressData] = useState({});
  const [gaugesData, setGaugesData] = useState({});
  const [exposureData, setExposureData] = useState({});
  const [compositeData, setCompositeData] = useState({});
  const [datasetHealth, setDatasetHealth] = useState(initialDatasetHealth);
  const [scoreboardData, setScoreboardData] = useState(null);
  const [lockedSignals, setLockedSignals] = useState({});
  const [candidates, setCandidates] = useState([]);
  const [candidatesLocked, setCandidatesLocked] = useState(false);
  const [muskCapexData, setMuskCapexData] = useState(defaultMuskData);
  const [muskIntel, setMuskIntel] = useState(null);
  const [muskIntelStatus, setMuskIntelStatus] = useState("idle");
  const [roboticsCapexData, setRoboticsCapexData] = useState(defaultRoboticsData);
  const [roboticsIntel, setRoboticsIntel] = useState(null);
  const [roboticsIntelStatus, setRoboticsIntelStatus] = useState("idle");
  const [prices, setPrices] = useState({});
  const pricesRef = useRef({});
  const capexDataRef = useRef(defaultCapexData);
  const muskDataRef = useRef(defaultMuskData);
  const roboticsDataRef = useRef(defaultRoboticsData);
  // Which view is showing — refresh fetches only that view's map, not both
  // (fetching both doubled the per-cycle ticker count and broke the cache).
  const activeViewRef = useRef(activeView);
  const loadedIntelViewsRef = useRef(new Set());
  const shortListRef = useRef([]);
  const [marketData, setMarketData] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {

    fetch("/capex")
      .then(res => readJsonResponse(res, "/capex"))
      .then(data => {
        if (data.capexData && (data.capexData.version ?? 0) >= defaultCapexData.version) {
          setCapexData(data.capexData);
          capexDataRef.current = data.capexData;
        }
      })
      .catch(() => {});

    fetch("/musk-capex")
      .then(res => readJsonResponse(res, "/musk-capex"))
      .then(data => {
        if (data.capexData && (data.capexData.version ?? 0) >= (defaultMuskData?.version ?? 1)) {
          setMuskCapexData(data.capexData);
          muskDataRef.current = data.capexData;
        }
      })
      .catch(() => {});

    fetch("/robotics-capex")
      .then(res => readJsonResponse(res, "/robotics-capex"))
      .then(data => {
        if (data.capexData && (data.capexData.version ?? 0) >= (defaultRoboticsData?.version ?? 1)) {
          setRoboticsCapexData(data.capexData);
          roboticsDataRef.current = data.capexData;
        }
      })
      .catch(() => {});

    fetch("/candidates")
      .then(res => readJsonResponse(res, "/candidates"))
      .then(json => {
        setCandidatesLocked(false);
        if (json.success && Array.isArray(json.candidates)) setCandidates(json.candidates);
      })
      .catch(error => {
        if (isLockedAccessError(error, ["admin_only"])) {
          setCandidates([]);
          setCandidatesLocked(true);
        }
      });
    fetch("/capex-history")
      .then(res => readJsonResponse(res, "/capex-history"))
      .then(json => {
        setLockedSignals(previous => ({ ...previous, capexHistory: false }));
        if (json.success && Array.isArray(json.history)) setCapexHistory(json.history);
      })
      .catch(error => {
        if (isLockedAccessError(error)) {
          setCapexHistory([]);
          setLockedSignals(previous => ({ ...previous, capexHistory: true }));
        }
      });

    fetch("/shortlist")
      .then(res => readJsonResponse(res, "/shortlist"))
      .then(data => {
        if (Array.isArray(data.tickers)) {
          setShortList(data.tickers);
          shortListRef.current = data.tickers;
        }
      })
      .catch(() => {});
  }, [defaultCapexData.version]);

  useEffect(() => {
    const datasetSetters = {
      stress: setStressData,
      gauges: setGaugesData,
      exposure: setExposureData,
      composite: setCompositeData,
    };
    const refreshDatasets = async signal => {
      const datasetTasks = Object.entries(DASHBOARD_DATASETS).map(
        async ([key, config]) => {
          try {
            const result = await fetchDashboardDataset(
              config.endpoint, fetch, { signal },
            );
            if (signal.aborted) return;
            if (result.locked) {
              datasetSetters[key]({});
              setLockedSignals(previous => ({ ...previous, [key]: true }));
              setDatasetHealth(previous => ({
                ...previous,
                [key]: {
                  ...previous[key],
                  loading: false,
                  error: null,
                  locked: true,
                },
              }));
              return;
            }
            const { data, health } = result;
            datasetSetters[key](data);
            setLockedSignals(previous => ({ ...previous, [key]: false }));
            setDatasetHealth(previous => ({ ...previous, [key]: health }));
          } catch (error) {
            if (signal.aborted) return;
            const reported = error?.datasetHealth ?? normalizeDatasetHealth(null);
            setDatasetHealth(previous => ({
              ...previous,
              [key]: {
                ...reported,
                loading: false,
                error: error?.message || `${config.label} unavailable`,
                stale: true,
              },
            }));
          }
        },
      );
      const scoreboardTask = (async () => {
        try {
          const response = await fetch("/scoreboard", { signal });
          const json = await readJsonResponse(response, "/scoreboard");
          if (!json.success) {
            const error = new Error(json.message || "Scoreboard unavailable");
            error.payload = json;
            throw error;
          }
          if (signal.aborted) return;
          setLockedSignals(previous => ({ ...previous, scoreboard: false }));
          setScoreboardData({
            stats: json.stats ?? [],
            events: json.events ?? [],
            statsByCohort: json.statsByCohort ?? null,
            eventsByCohort: json.eventsByCohort ?? null,
            methodology: json.methodology ?? null,
            health: normalizeDatasetHealth(json.health),
          });
        } catch (error) {
          if (signal.aborted) return;
          if (isLockedAccessError(error)) {
            setLockedSignals(previous => ({ ...previous, scoreboard: true }));
            setScoreboardData({ locked: true });
            return;
          }
          setScoreboardData({
            error: true,
            health: normalizeDatasetHealth(error?.payload?.health),
          });
        }
      })();
      await Promise.allSettled([...datasetTasks, scoreboardTask]);
    };

    return startDashboardRefreshLoop({ refresh: refreshDatasets });
  }, []);

  // The three intel routes can invoke paid generation. Fetch only the map
  // currently on screen, and keep standalone views from touching them at all.
  useEffect(() => {
    const endpoint = intelEndpointForView(activeView);
    if (!endpoint || loadedIntelViewsRef.current.has(activeView)) return undefined;

    const config = activeView === "ai"
      ? {
          setData: setCapexIntel,
          setStatus: setCapexIntelStatus,
          setError: setCapexIntelError,
        }
      : activeView === "musk"
        ? { setData: setMuskIntel, setStatus: setMuskIntelStatus }
        : { setData: setRoboticsIntel, setStatus: setRoboticsIntelStatus };
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    let finished = false;
    let retry = null;
    const fail = message => {
      if (cancelled || finished) return;
      finished = true;
      clearTimeout(retry);
      config.setStatus("error");
      config.setError?.(message);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      fail("Request timed out — the intel refresh took too long");
      controller.abort();
    }, INTEL_TIMEOUT_MS);

    config.setStatus("loading");
    config.setError?.(null);
    const loadIntel = async () => {
      if (cancelled || finished) return;
      try {
        const response = await fetch(endpoint, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok || data.error || !data.allocations?.length) {
          throw new Error(data.detail || data.error || "No allocations returned from API.");
        }
        if (cancelled || finished) return;
        config.setData(data);
        if (data.stale === true) {
          config.setStatus("stale");
          retry = setTimeout(() => void loadIntel(), 5_000);
          return;
        }
        finished = true;
        clearTimeout(timeout);
        config.setStatus("success");
        loadedIntelViewsRef.current.add(activeView);
      } catch (error) {
        fail(
          timedOut
            ? "Request timed out — the intel refresh took too long"
            : (error?.message || "Network error")
        );
      }
    };
    void loadIntel();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      clearTimeout(retry);
      controller.abort();
    };
  }, [activeView]);

  useEffect(() => {
    capexDataRef.current = capexData;
  }, [capexData]);

  useEffect(() => {
    muskDataRef.current = muskCapexData;
  }, [muskCapexData]);

  useEffect(() => {
    roboticsDataRef.current = roboticsCapexData;
  }, [roboticsCapexData]);


  useEffect(() => {
    shortListRef.current = shortList;
  }, [shortList]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const marketTickers = [...indexTickers, ...cryptoTickers, ...hyperscalerTickers];
    // Map views fetch only their active universe. Standalone research keeps a
    // deliberately narrow price scope.
    const currentView = activeViewRef.current;
    const usesMapUniverse = ["ai", "musk", "robotics", "earnings"].includes(currentView);
    const activeMap =
      currentView === "robotics" && roboticsDataRef.current ? roboticsDataRef.current :
      currentView === "musk" && muskDataRef.current ? muskDataRef.current :
      capexDataRef.current;
    const scopedTickers = usesMapUniverse
      ? [
          ...getAllTickers(activeMap),
          ...shortListRef.current,
          ...pinnedTickers,
        ]
      : [];
    const allTickers = [...new Set([
      ...scopedTickers,
      ...marketTickers,
    ])];

    const allData = await fetchAllPrices(allTickers);

    setPrices(prev => {
      const next = mergePriceEntries(prev, allData);
      pricesRef.current = next;
      return next;
    });
    setMarketData(prev => {
      const merged = { ...prev };
      marketTickers.forEach(ticker => {
        const val = allData[ticker];
        if (val != null && typeof val === "object" && val.price != null) merged[ticker] = val;
        else if (val != null) merged[ticker] = val;
      });
      return merged;
    });
    setLastUpdated(new Date().toLocaleTimeString());
    setRefreshing(false);
  }, [cryptoTickers, fetchAllPrices, getAllTickers, hyperscalerTickers, indexTickers, pinnedTickers]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 30000);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const fastRefresh = async () => {
      if (document.hidden) return;
      try {
        const stripTickers = [...indexTickers, ...cryptoTickers];
        const data = await fetchAllPrices(stripTickers);
        setMarketData(prev => {
          const merged = { ...prev };
          stripTickers.forEach(ticker => {
            const val = data[ticker];
            if (val != null) {
              merged[ticker] = { ...prev[ticker], ...val };
            }
          });
          return merged;
        });
      } catch (err) {}
    };
    const id = setInterval(fastRefresh, 5000);
    return () => clearInterval(id);
  }, [cryptoTickers, fetchAllPrices, indexTickers]);

  return {
    shortList,
    setShortList,
    capexData,
    setCapexData,
    capexIntel,
    capexIntelStatus,
    capexIntelError,
    capexHistory,
    stressData,
    gaugesData,
    exposureData,
    compositeData,
    datasetHealth,
    scoreboardData,
    lockedSignals,
    candidates,
    candidatesLocked,
    setCandidates,
    muskCapexData,
    setMuskCapexData,
    muskIntel,
    muskIntelStatus,
    roboticsCapexData,
    setRoboticsCapexData,
    roboticsIntel,
    roboticsIntelStatus,
    prices,
    pricesRef,
    marketData,
    lastUpdated,
    refreshing,
    refresh,
    capexDataRef,
    muskDataRef,
    roboticsDataRef,
    activeViewRef,
    shortListRef,
  };
}
