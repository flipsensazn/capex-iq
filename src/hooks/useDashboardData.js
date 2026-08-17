import { useCallback, useEffect, useRef, useState } from "react";

const INTEL_TIMEOUT_MS = 60_000;

export function intelEndpointForView(view) {
  if (view === "ai") return "/capex-intel";
  if (view === "musk") return "/musk-intel";
  if (view === "robotics") return "/robotics-intel";
  return null;
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
  defaultScannerPool,
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
  const [scannerPool, setScannerPool] = useState(defaultScannerPool);
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
  const [scoreboardData, setScoreboardData] = useState(null);
  const [candidates, setCandidates] = useState([]);
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
  const scannerPoolRef = useRef(defaultScannerPool);
  const shortListRef = useRef([]);
  const [marketData, setMarketData] = useState({});
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetch("/scanner")
      .then(res => res.json())
      .then(data => {
        if (data.tickers) {
          setScannerPool(data.tickers);
          scannerPoolRef.current = data.tickers;
        }
      })
      .catch(() => {});

    fetch("/capex")
      .then(res => res.json())
      .then(data => {
        if (data.capexData && (data.capexData.version ?? 0) >= defaultCapexData.version) {
          setCapexData(data.capexData);
          capexDataRef.current = data.capexData;
        }
      })
      .catch(() => {});

    fetch("/musk-capex")
      .then(res => res.json())
      .then(data => {
        if (data.capexData && (data.capexData.version ?? 0) >= (defaultMuskData?.version ?? 1)) {
          setMuskCapexData(data.capexData);
          muskDataRef.current = data.capexData;
        }
      })
      .catch(() => {});

    fetch("/robotics-capex")
      .then(res => res.json())
      .then(data => {
        if (data.capexData && (data.capexData.version ?? 0) >= (defaultRoboticsData?.version ?? 1)) {
          setRoboticsCapexData(data.capexData);
          roboticsDataRef.current = data.capexData;
        }
      })
      .catch(() => {});

    fetch("/stress")
      .then(res => res.json())
      .then(json => {
        if (json.success && json.data) setStressData(json.data);
      })
      .catch(() => {});

    fetch("/gauges")
      .then(res => res.json())
      .then(json => {
        if (json.success && json.data) setGaugesData(json.data);
      })
      .catch(() => {});

    fetch("/exposure")
      .then(res => res.json())
      .then(json => {
        if (json.success && json.data) setExposureData(json.data);
      })
      .catch(() => {});

    fetch("/composite")
      .then(res => res.json())
      .then(json => {
        if (json.success && json.data) setCompositeData(json.data);
      })
      .catch(() => {});

    fetch("/scoreboard")
      .then(async res => {
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || "Scoreboard unavailable");
        return json;
      })
      .then(json => {
        setScoreboardData({
          stats: json.stats ?? [],
          events: json.events ?? [],
          statsByCohort: json.statsByCohort ?? null,
          eventsByCohort: json.eventsByCohort ?? null,
          methodology: json.methodology ?? null,
        });
      })
      .catch(() => setScoreboardData({ error: true }));

    fetch("/candidates")
      .then(res => res.json())
      .then(json => {
        if (json.success && Array.isArray(json.candidates)) setCandidates(json.candidates);
      })
      .catch(() => {});
    fetch("/capex-history")
      .then(res => res.json())
      .then(json => {
        if (json.success && Array.isArray(json.history)) setCapexHistory(json.history);
      })
      .catch(() => {});

    fetch("/shortlist")
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data.tickers)) {
          setShortList(data.tickers);
          shortListRef.current = data.tickers;
        }
      })
      .catch(() => {});
  }, [defaultCapexData.version]);

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
    scannerPoolRef.current = scannerPool;
  }, [scannerPool]);

  useEffect(() => {
    shortListRef.current = shortList;
  }, [shortList]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const marketTickers = [...indexTickers, ...cryptoTickers, ...hyperscalerTickers];
    // Map views fetch only their active universe. Standalone research and
    // scanner views keep a deliberately narrow price scope.
    const currentView = activeViewRef.current;
    const usesMapUniverse = ["ai", "musk", "robotics", "earnings"].includes(currentView);
    const activeMap =
      currentView === "robotics" && roboticsDataRef.current ? roboticsDataRef.current :
      currentView === "musk" && muskDataRef.current ? muskDataRef.current :
      capexDataRef.current;
    const scopedTickers = usesMapUniverse
      ? [
          ...getAllTickers(activeMap),
          ...scannerPoolRef.current,
          ...shortListRef.current,
          ...pinnedTickers,
        ]
      : currentView === "scanner"
        ? [...scannerPoolRef.current, ...shortListRef.current]
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
    scannerPool,
    setScannerPool,
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
    scoreboardData,
    candidates,
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
    scannerPoolRef,
    shortListRef,
  };
}
