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
  indexTickers,
  cryptoTickers,
  hyperscalerTickers,
  fetchAllPrices,
  getAllTickers,
}) {
  const [scannerPool, setScannerPool] = useState(defaultScannerPool);
  const [shortList, setShortList] = useState([]);
  const [capexData, setCapexData] = useState(defaultCapexData);
  const [capexIntel, setCapexIntel] = useState(null);
  const [capexIntelStatus, setCapexIntelStatus] = useState("idle");
  const [capexIntelError, setCapexIntelError] = useState(null);
  const [newsFeed, setNewsFeed] = useState([]);
  const [stressData, setStressData] = useState({});
  const [gaugesData, setGaugesData] = useState({});
  const [exposureData, setExposureData] = useState({});
  const [prices, setPrices] = useState({});
  const pricesRef = useRef({});
  const capexDataRef = useRef(defaultCapexData);
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
    const fetchSectorNews = () => {
      fetch("/news")
        .then(res => res.json())
        .then(data => {
          if (data.news) setNewsFeed(data.news);
        })
        .catch(() => {});
    };

    fetchSectorNews();
    const newsInterval = setInterval(() => {
      if (!document.hidden) {
        fetchSectorNews();
      }
    }, 60000);

    return () => clearInterval(newsInterval);
  }, []);

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
    scannerPoolRef.current = scannerPool;
  }, [scannerPool]);

  useEffect(() => {
    shortListRef.current = shortList;
  }, [shortList]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const marketTickers = [...indexTickers, ...cryptoTickers, ...hyperscalerTickers];
    const allTickers = [...new Set([
      ...getAllTickers(capexDataRef.current),
      ...scannerPoolRef.current,
      ...shortListRef.current,
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
  }, [cryptoTickers, fetchAllPrices, getAllTickers, hyperscalerTickers, indexTickers]);

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
    newsFeed,
    stressData,
    gaugesData,
    exposureData,
    prices,
    pricesRef,
    marketData,
    lastUpdated,
    refreshing,
    refresh,
    capexDataRef,
    scannerPoolRef,
    shortListRef,
  };
}
