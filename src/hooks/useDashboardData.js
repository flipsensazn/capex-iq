import { useCallback, useEffect, useRef, useState } from "react";

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
  const activeViewRef = useRef("ai");
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

    setMuskIntelStatus("loading");
    fetch("/musk-intel")
      .then(res => res.json())
      .then(data => {
        if (!data.error && data.allocations?.length) {
          setMuskIntel(data);
          setMuskIntelStatus("success");
        } else {
          setMuskIntelStatus("error");
        }
      })
      .catch(() => setMuskIntelStatus("error"));

    fetch("/robotics-capex")
      .then(res => res.json())
      .then(data => {
        if (data.capexData && (data.capexData.version ?? 0) >= (defaultRoboticsData?.version ?? 1)) {
          setRoboticsCapexData(data.capexData);
          roboticsDataRef.current = data.capexData;
        }
      })
      .catch(() => {});

    setRoboticsIntelStatus("loading");
    fetch("/robotics-intel")
      .then(res => res.json())
      .then(data => {
        if (!data.error && data.allocations?.length) {
          setRoboticsIntel(data);
          setRoboticsIntelStatus("success");
        } else {
          setRoboticsIntelStatus("error");
        }
      })
      .catch(() => setRoboticsIntelStatus("error"));

    setCapexIntelStatus("loading");
    const intelController = new AbortController();
    const intelTimeout = setTimeout(() => intelController.abort(), 20000);
    fetch("/capex-intel", { signal: intelController.signal })
      .then(res => res.json())
      .then(data => {
        clearTimeout(intelTimeout);
        if (data.error) {
          setCapexIntelStatus("error");
          setCapexIntelError(data.detail ? `${data.error} — ${data.detail}` : data.error);
        } else if (data.allocations?.length) {
          setCapexIntel(data);
          setCapexIntelStatus("success");
        } else {
          setCapexIntelStatus("error");
          setCapexIntelError("No allocations returned from API.");
        }
      })
      .catch(e => {
        clearTimeout(intelTimeout);
        setCapexIntelStatus("error");
        setCapexIntelError(e.name === "AbortError" ? "Request timed out — Gemini took too long" : (e.message || "Network error"));
      });

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
      .then(res => res.json())
      .then(json => {
        if (json.success) setScoreboardData({ stats: json.stats ?? [], events: json.events ?? [] });
      })
      .catch(() => {});

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

  useEffect(() => {
    const marketTickers = [...indexTickers, ...cryptoTickers, ...hyperscalerTickers];
    fetchAllPrices(marketTickers).then(data => {
      setMarketData(prev => {
        const merged = { ...prev };
        marketTickers.forEach(ticker => {
          const val = data[ticker];
          if (val != null) merged[ticker] = val;
        });
        return merged;
      });
      setPrices(prev => {
        const next = mergePriceEntries(prev, data);
        pricesRef.current = next;
        return next;
      });
    });
  }, [cryptoTickers, fetchAllPrices, hyperscalerTickers, indexTickers]);

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
    // Only the ACTIVE view's map is on screen, so only fetch its tickers —
    // the heat map, watchlist, Sankey, graph and earnings panels all read the
    // active view. The inactive view's prices are fetched when you switch to it.
    const activeMap =
      activeViewRef.current === "robotics" && roboticsDataRef.current ? roboticsDataRef.current :
      activeViewRef.current === "musk" && muskDataRef.current ? muskDataRef.current :
      capexDataRef.current;
    const allTickers = [...new Set([
      ...getAllTickers(activeMap),
      ...scannerPoolRef.current,
      ...shortListRef.current,
      ...marketTickers,
      ...pinnedTickers,  // public hub companies not in a map (e.g. TSLA for the Musk Sankey)
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
    refresh();
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
