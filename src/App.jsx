import { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import AdminModal from "./components/AdminModal";
import AnalysisDrawer from "./components/AnalysisDrawer";
import BottleneckScout from "./components/BottleneckScout";
import CapexSankey from "./components/CapexSankey";
import FearGreedGauge from "./components/FearGreedGauge";
import StatusBanner from "./components/StatusBanner";
import TopBar from "./components/TopBar";
import SupplyGraph from "./components/capex-map/SupplyGraph";
import TrackCard from "./components/capex-map/TrackCard";
import TrackPane from "./components/capex-map/TrackPane";
import { MUSK_CAPEX_DATA, MUSK_COMPANIES, MUSK_GRAPH_NODES, MUSK_GRAPH_EDGES, MUSK_LAYERS } from "./components/capex-map/muskData";
import { useAdminActions } from "./hooks/useAdminActions";
import { useDashboardData } from "./hooks/useDashboardData";
import { usePresence } from "./hooks/usePresence";

// ── MOBILE CONTEXT ──────────────────────────────────────
const MobileCtx = createContext(false);
function useMobile() { return useContext(MobileCtx); }

// ── MARKET DATA ───────────────────────────────────────────────────────────────
const INDEX_TICKERS = ["^GSPC", "^DJI", "^IXIC"];
const CRYPTO_TICKERS = ["BTC-USD", "ETH-USD", "XRP-USD"];
const HYPERSCALER_TICKERS = ["AMZN", "MSFT", "GOOG", "META", "ORCL"];

// The default Multibagger Scanner list
const DEFAULT_MULTIBAGGER = [
  "YELP", "NVRI", "CXM", "SFL", "WWW", "FIVN", "STGW", "ECVT", "CRI", 
  "TRIP", "OLPX", "LZ", "GLDD", "ARHS", "ACEL", "CRCT", "PGY", "TDAY", 
  "NABL", "NRDS", "STKL", "UDMY", "GOGO", "YEXT", "EHAB", "AHH", "RIGL", 
  "RPD", "AKBA"
];

// ── PRICE FETCHING ────────────────────────────────────────
async function fetchAllPrices(tickers) {
  try {
    const res = await fetch(`/prices?tickers=${tickers.join(",")}`);
    const json = await res.json();
    return json.data ?? {};
  } catch {
    return {};
  }
}

// ── SHARED UTILITIES ──────────────────────────────────────
function fmtMarketCap(n) {
  if (n == null || isNaN(n)) return "—";
  const num = Number(n);
  if (num >= 1e12) return "$" + (num / 1e12).toFixed(2) + "T";
  if (num >= 1e9)  return "$" + (num / 1e9).toFixed(2) + "B";
  if (num >= 1e6)  return "$" + (num / 1e6).toFixed(2) + "M";
  return "$" + num.toLocaleString();
}

function getChangeForTimeline(entry, timeline) {
  if (!entry || typeof entry !== "object") return entry?.change ?? entry;
  switch(timeline) {
    case "5D":  return entry.change5D;
    case "1M":  return entry.change1M;
    case "6M":  return entry.change6M;
    case "YTD": return entry.changeYTD;
    case "1Y":  return entry.change1Y;
    default:    return entry.change;
  }
}

// ── QUOTE SUMMARY (for company popup) ────────────────────
const quoteCache = {};
const QUOTE_CACHE_TTL = 5 * 60 * 1000;
const QUOTE_CACHE_MAX = 50;

async function fetchQuoteSummary(ticker, attempt = 0) {
  const now = Date.now();
  if (quoteCache[ticker] && (now - quoteCache[ticker].timestamp < QUOTE_CACHE_TTL)) {
    return quoteCache[ticker].data;
  }

  try {
    const url = `/quote?ticker=${encodeURIComponent(ticker)}`;
    const res = await fetch(url);
    const json = await res.json();
    const payload = json.data ? json.data : json;
    const r = payload?.quoteSummary?.result?.[0];
    const chartResult = payload?.chart?.result?.[0];
    const newsResult = payload?.news;
    if (!r) {
      // Transient Yahoo-session blip on the server (now answered uncacheable)
      // — one retry after a short pause usually lands on a fresh session.
      if (attempt < 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        return fetchQuoteSummary(ticker, attempt + 1);
      }
      return null;
    }

    const profile = r.assetProfile ?? {};
    const detail  = r.summaryDetail ?? {};
    const price   = r.price ?? {};
    const events  = r.calendarEvents ?? {};

    let chartPoints = [], chartDates = [];
    if (chartResult && chartResult.indicators?.quote?.[0]?.close && chartResult.timestamp) {
      const closes = chartResult.indicators.quote[0].close;
      const timestamps = chartResult.timestamp;
      for (let i = 0; i < closes.length; i++) {
        if (closes[i] !== null) {
          chartPoints.push(closes[i]);
          chartDates.push(timestamps[i] * 1000); 
        }
      }
    }

    const currentPriceRaw = price.regularMarketPrice?.raw ?? price.regularMarketPrice;

    const data = {
      name:         price.longName || price.shortName || ticker,
      currentPrice: currentPriceRaw != null ? "$" + Number(currentPriceRaw).toFixed(2) : null,
      sector:       profile.sector || "—",
      industry:     profile.industry || "—",
      description:  profile.longBusinessSummary || null,
      marketCap:    fmtMarketCap(price.marketCap?.raw ?? price.marketCap),
      peRatio:      detail.trailingPE?.raw != null ? Number(detail.trailingPE.raw).toFixed(1) : "—",
      week52Low:    detail.fiftyTwoWeekLow?.raw != null ? "$" + Number(detail.fiftyTwoWeekLow.raw).toFixed(2) : "—",
      week52High:   detail.fiftyTwoWeekHigh?.raw != null ? "$" + Number(detail.fiftyTwoWeekHigh.raw).toFixed(2) : "—",
      employees:    profile.fullTimeEmployees ? Number(profile.fullTimeEmployees).toLocaleString() : "—",
      country:      profile.country || "—",
      website:      profile.website || null,
      chartData:    chartPoints,
      chartDates:   chartDates,
      rawPrice:     currentPriceRaw,
      raw52Low:     detail.fiftyTwoWeekLow?.raw,
      raw52High:    detail.fiftyTwoWeekHigh?.raw,
      earningsDate: events.earnings?.earningsDate?.[0]?.raw ?? null,
      news:         newsResult ? {
                      title: newsResult.title,
                      link: newsResult.link,
                      publisher: newsResult.publisher
                    } : null
    };

    const cacheKeys = Object.keys(quoteCache);
    if (cacheKeys.length >= QUOTE_CACHE_MAX) {
      const oldest = cacheKeys.reduce((a, b) => quoteCache[a].timestamp < quoteCache[b].timestamp ? a : b);
      delete quoteCache[oldest];
    }
    quoteCache[ticker] = { data, timestamp: now };
    return data;
  } catch (err) {
    return null;
  }
}

// ── DEFAULT CAPEX DATA ────────────────────────────────────
// version 3: full ticker-placement audit (2026-06). Every ticker identity
// verified against live quote data; misfiled names moved; invalid tickers
// removed (COR = Cencora, not CoreSite). Supersedes the v2 map saved in KV.
const CAPEX_DATA = {
  version: 3,
  companies: ["AMZN", "MSFT", "GOOG", "META", "ORCL"],
  tracks: [
    {
      id: "compute", label: "Compute & Silicon", value: "~$180B", capex: 180,
      color: "#60a5fa", borderColor: "#3b82f6",
      subsectors: [
        { id: "gpu", label: "GPU & AI Accelerators", tickers: ["NVDA","AMD"], materials: ["Cobalt","Tungsten","Silicon Wafer 300mm","HBM DRAM"] },
        { id: "memory", label: "Memory & Storage", tickers: ["MU","PSTG","NTAP","SNDK","RMBS","DRAM"], materials: ["HBM3e Stacks","LPDDR5","3D NAND Flash","Silicon Wafer 300mm"] },
        { id: "asic", label: "Custom ASICs & TPUs", tickers: ["AVGO","MRVL"], materials: ["Advanced Packaging CoWoS","HBM","EUV Photomasks"] },
        { id: "foundry", label: "Foundry", tickers: ["TSM","INTC","UMC"], materials: ["Silicon Carbide","Neon Gas","EUV Resist","Cobalt"] },
        { id: "equip", label: "Semiconductor Equipment", tickers: ["AMAT","LRCX","ASML","KLAC","PLAB","EUV"], materials: ["Rare Earth Magnets","Fluorine Gas","Quartz"] },
        { id: "packaging", label: "Advanced Packaging", tickers: ["AMKR","ASX","CAMT","ONTO"], materials: ["Advanced Packaging CoWoS","HBM","Fan-Out Wafer"] },
        { id: "testing", label: "Chip Testing", tickers: ["FORM","AEHR","TER","TRT"], materials: ["Probe Cards","Test Sockets","Burn-in Boards"] },
        { id: "eda", label: "EDA & Chip Design IP", tickers: ["CDNS","SNPS","ARM"], materials: ["IP Cores","Compute Licenses","Cloud Simulation"] },
      ],
    },
    {
      id: "networking", label: "Networking & Connectivity", value: "~$50B", capex: 50,
      color: "#34d399", borderColor: "#10b981",
      subsectors: [
        { id: "eth", label: "Ethernet Switching", tickers: ["ANET","CSCO","HPE"], materials: ["Copper Cat8","PCB Laminate","Silicon"] },
        { id: "cable", label: "Cables & Connectors", tickers: ["GLW","TEL","APH"], materials: ["Copper","Optical Fiber SiO2","Polymer Cladding"] },
        { id: "cyber", label: "Cybersecurity", tickers: ["PANW","CRWD","ZS"], materials: ["Secure Enclaves","HSM Hardware","Zero Trust Infrastructure"] },
        { id: "testmeas", label: "Test & Measurement", tickers: ["KEYS","VIAV"], materials: ["RF Instruments","Optical Test Heads","Calibration Standards"] },
      ],
    },
    {
      id: "photonics", label: "Photonics & Interconnects", value: "~$40B", capex: 35,
      color: "#fbbf24", borderColor: "#f59e0b",
      subsectors: [
        { id: "engine", label: "Optical Engine & Transceiver L1", tickers: ["LITE","COHR","AAOI","MTSI","SIVEF","SMTC"], materials: ["InP Chips","Silicon Photonics Dies","Single-Mode Fiber"] },
        { id: "inp", label: "InP Substrate & Epiwafer L2", tickers: ["AXTI","IQEPF"], materials: [ { name: "Indium", constraint: "CRITICAL — 70% supply from China", color: "#ef4444" }, { name: "Phosphorus", constraint: "Moderate supply risk", color: "#f59e0b" }, { name: "InP Wafer 2-4\"", constraint: "Capacity severely limited", color: "#ef4444" }, { name: "Gallium", constraint: "China export controls active", color: "#ef4444" }, ] },
        { id: "epitaxy", label: "Epitaxy Equipment L3", tickers: ["VECO"], materials: ["Trimethylindium TMIn","Phosphine PH3","Quartz Chambers"] },
        { id: "siph", label: "SiPh Foundry & SOI Substrates L4", tickers: ["TSEM","GFS","SLOIF"], materials: ["Silicon-on-Insulator Wafers","Germanium","TiN Electrodes"] },
        { id: "retimers", label: "Connectivity Silicon (Retimers & AECs)", tickers: ["ALAB","CRDO"], materials: ["High-Speed Copper","Differential Pair PCB","Signal Integrity"] },
        { id: "optnet", label: "Optical Networking & Transport", tickers: ["CIEN","NOK","ADTN"], materials: ["Coherent DSPs","ROADM Modules","Line Cards"] },
        { id: "pkgtest", label: "Optical Manufacturing & EMS", tickers: ["FN","SANM"], materials: ["Optical Subassemblies","Precision Optics","Cleanroom Capacity"] },
        { id: "cpo", label: "CPO / Optical Packaging", tickers: ["HIMX","POET","LWLG"], materials: ["Wafer-Level Optics","EO Polymers","Glass Substrates"] },
      ],
    },
    {
      id: "neoclouds", label: "Neoclouds & Data Centers", value: "~$120B", capex: 120,
      color: "#c084fc", borderColor: "#a855f7",
      subsectors: [
        { id: "reit", label: "Hyperscale REITs", tickers: ["EQIX","DLR","AMT"], materials: ["Structural Steel","Concrete","Copper Busbar","Fiber"] },
        { id: "neocloud", label: "GPU Cloud Operators", tickers: ["CIFR","IREN","CORZ","APLD","CRWV","NBIS","DGXX"], materials: ["Power Infrastructure","Cooling Systems","High-density Racks"] },
        { id: "servers", label: "AI Server & Modular Infrastructure", tickers: ["SMCI","DELL","TSSI","JBL","CLS"], materials: ["Copper Heat Pipes","PCB","Aluminum Extrusions"] },
        { id: "mep", label: "Mechanical, Electrical & Plumbing", tickers: ["FIX","EME","MTZ","PWR"], materials: ["Electrical Conduit","HVAC Systems","Industrial Piping"] },
      ],
    },
    {
      id: "power", label: "Power & Cooling", value: "~$45B", capex: 45,
      color: "#fb923c", borderColor: "#f97316",
      subsectors: [
        { id: "grid", label: "Power Generation & Utilities", tickers: ["VST","NEE","BE","GEV","POW"], materials: ["Copper Grid","Silicon Steel Transformers","Lithium Storage"] },
        { id: "nuclear", label: "Nuclear", tickers: ["OKLO","SMR","LEU","ASPI","NNE","IMSR","BWXT"], materials: ["Enriched Uranium","Zirconium Cladding","Boron Control Rods"] },
        { id: "ups", label: "Power Management & UPS", tickers: ["ETN","VRT","PLPC","ENS","HUBB","POWL","FPS","FLNC"], materials: ["Silicon Carbide SiC","Electrolytic Capacitors","Copper Winding"] },
        { id: "cooling", label: "Liquid & Immersion Cooling", tickers: ["MOD","NVT","TT"], materials: ["Dielectric Fluid","Copper Cold Plates","Deionized Water"] },
        { id: "powersemi", label: "Power Semiconductors (SiC / GaN)", tickers: ["WOLF","STM","ON","NVTS"], materials: ["SiC Boules","GaN-on-Si Epiwafers","200mm SiC Wafers"] },
        { id: "passives", label: "Passives & Power Delivery", tickers: ["MRAAY","TTDKY"], materials: [ { name: "MLCC Capacity", constraint: "AI server demand straining supply", color: "#f59e0b" }, "Ferrite Cores", "Power Inductors" ] },
      ],
    },
    {
      id: "frontier", label: "Frontier / Speculative", value: "Early", capex: 15,
      color: "#f472b6", borderColor: "#ec4899",
      subsectors: [
        { id: "quantum", label: "Quantum Computing", tickers: ["IONQ","RGTI","QUBT","ARQQ","QTUM"], materials: [ { name: "Helium-3", constraint: "CRITICAL — extremely scarce", color: "#ef4444" }, { name: "Niobium", constraint: "Limited processing capacity", color: "#f59e0b" }, { name: "Sapphire Substrate", constraint: "Moderate availability", color: "#60a5fa" }, ] },
        { id: "edge", label: "Edge AI & IoT Connectivity", tickers: ["OSS","QCOM","SYNA"], materials: ["NPU IP","LPDDR","RF Front-Ends"] },
        { id: "space", label: "Space", tickers: ["RKLB","ASTS","NASA","SIDU","SATL","PL","RDW","MNTS","FLTCF"], materials: ["Radiation-Hardened Chips","Composites","RF Amplifiers"] },
        { id: "saas", label: "SaaS", tickers: ["PLTR","SNOW","NOW","CRM","DDOG"], materials: ["Cloud Infrastructure","API Gateways","Multi-tenant Architecture"] },
        { id: "robotics", label: "Robotics", tickers: ["SYM","TSLA","KRKNF","ONDS","LIDR","UMAC","AVAV","CTS"], materials: ["Servo Motors","LiDAR Sensors","Carbon Fiber Composites"] },
        { id: "metals", label: "Precious Metals & Commodities", tickers: ["USAS","COPX","SLV","GLD","NEM"], materials: [ { name: "Gold", constraint: "Safe haven demand rising", color: "#f59e0b" }, { name: "Silver", constraint: "Industrial + monetary demand", color: "#94a3b8" }, { name: "Copper", constraint: "CRITICAL — AI grid buildout demand", color: "#fb923c" }, ] },
        { id: "minerals", label: "Critical Minerals & Rare Earths", tickers: ["UUUU","MP","USAR","CRML","RIO","NB","REMX"], materials: [ { name: "Rare Earth Magnets", constraint: "China processing dominance", color: "#ef4444" }, "Uranium", "Niobium" ] },
      ],
    },
  ],
};

function getAllTickers(data = CAPEX_DATA) {
  return [...new Set(data.tracks.flatMap(t => t.subsectors.flatMap(s => s.tickers)))];
}

// ── UI COMPONENTS ─────────────────────────────────────────

function EditableLabel({ text, onSave, isAdmin, style, textStyles }) {
  const [isEditing, setIsEditing] = useState(false);
  const [val, setVal] = useState(text);

  if (!isEditing) {
    return (
      <span
        onDoubleClick={(e) => {
          if (isAdmin) {
            e.stopPropagation();
            setIsEditing(true);
          }
        }}
        style={{ ...style, ...textStyles, cursor: isAdmin ? "text" : "default" }}
        title={isAdmin ? "Double-click to edit" : undefined}
      >
        {text}
      </span>
    );
  }
  return (
    <input
      autoFocus
      value={val}
      onChange={e => setVal(e.target.value)}
      onBlur={() => {
        setIsEditing(false);
        if (val.trim() && val !== text) onSave(val.trim());
        else setVal(text);
      }}
      onKeyDown={e => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setVal(text); setIsEditing(false); }
      }}
      style={{ ...style, ...textStyles, background: "rgba(0,0,0,0.3)", border: "1px dashed #64748b", outline: "none", padding: "0 4px", borderRadius: 4 }}
      onClick={e => e.stopPropagation()}
    />
  );
}

function MiniChart({ data, dates, color, ticker }) {
  if (!data || data.length < 2) return null;
  const min = data.reduce((a, b) => Math.min(a, b), Infinity);
  const max = data.reduce((a, b) => Math.max(a, b), -Infinity);
  const padding = (max - min) * 0.1 || 1; 
  const yMin = min - padding, yMax = max + padding, range = yMax - yMin;
  const width = 160, height = 120; 
  
  const points = data.map((val, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((val - yMin) / (range || 1)) * height;
    return `${x},${y}`;
  }).join(" ");

  const cleanColor = color ? color.replace(/[^#0-9a-fA-F]/g, '') : "ffffff";
  const gradientId = `grad-${ticker || "x"}-${cleanColor}`;
  const priceLabels = Array.from({ length: 10 }, (_, i) => max - (i * (max - min) / 9));

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible", display: "block" }}>
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.3" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {priceLabels.map((val, i) => {
             const yPos = height - ((val - yMin) / (range || 1)) * height;
             return <line key={i} x1="0" y1={yPos} x2={width} y2={yPos} stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="2,2" />
          })}
          <polygon fill={`url(#${gradientId})`} points={`${points} ${width},${height} 0,${height}`} />
          <polyline fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={points} />
        </svg>
        <div style={{ position: 'relative', height: height, width: 45, marginLeft: 8, fontSize: 9, color: "#94a3b8", fontFamily: "monospace" }}>
          {priceLabels.map((val, i) => {
              const yPos = height - ((val - yMin) / (range || 1)) * height;
              return <span key={i} style={{ position: 'absolute', top: yPos, transform: 'translateY(-50%)', left: 0 }}>${val.toFixed(2)}</span>;
          })}
        </div>
      </div>
    </div>
  );
}

// ── COMPANY POPUP ─────────────────────────────────────────
function CompanyPopup({ ticker, change, anchorRect, onClose, onOpenAnalysis }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const popupRef = useRef(null);
  const pos = (change ?? 0) >= 0;
  const changeColor = change === undefined ? "#475569" : pos ? "#34d399" : "#f87171";

  const runAnalysis = async () => {
    if (analysisLoading) return;
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const res = await fetch("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          currentPrice: data?.rawPrice ?? null,
          peRatio:      data?.peRatio  ?? null,
          marketCap:    data?.marketCap ?? null,
          week52Low:    data?.raw52Low  ?? null,
          week52High:   data?.raw52High ?? null,
          sector:       data?.sector   ?? null,
          industry:     data?.industry ?? null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error || "Analysis failed");
      onOpenAnalysis(json);
    } catch (err) {
      setAnalysisError(err.message);
    } finally {
      setAnalysisLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchQuoteSummary(ticker).then(d => { setData(d); setLoading(false); });
  }, [ticker]);

  useEffect(() => {
    function handler(e) { if (popupRef.current && !popupRef.current.contains(e.target)) onClose(); }
    const id = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => { clearTimeout(id); document.removeEventListener("mousedown", handler); };
  }, [onClose]);

  useEffect(() => {
    function handler(e) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const POPUP_W = 500, POPUP_H = 400; 
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = anchorRect ? anchorRect.left : vw / 2 - POPUP_W / 2;
  let top  = anchorRect ? anchorRect.top - POPUP_H - 10 : vh / 2 - POPUP_H / 2;
  
  if (top < 10) top = anchorRect ? anchorRect.bottom + 10 : vh / 2 - POPUP_H / 2;
  if (top + POPUP_H > vh - 12) top = vh - POPUP_H - 12;
  if (top < 12) top = 12;
  if (left + POPUP_W > vw - 12) left = vw - POPUP_W - 12;
  if (left < 12) left = 12;

  let chartColor = changeColor;
  let monthChangePct = null; 
  if (data?.chartData && data.chartData.length >= 2) {
      const firstPrice = data.chartData[0];
      const lastPrice = data.chartData[data.chartData.length - 1];
      chartColor = lastPrice >= firstPrice ? "#34d399" : "#f87171";
      monthChangePct = ((lastPrice - firstPrice) / firstPrice) * 100;
  }

  return (
    <div ref={popupRef} style={{
      position: "fixed", top, left, width: POPUP_W, zIndex: 3000,
      background: "rgba(18,18,18,0.97)", border: `1px solid ${changeColor}44`,
      borderRadius: 14, boxShadow: `0 8px 48px rgba(0,0,0,0.85), 0 0 30px ${changeColor}18`,
      fontFamily: "'DM Mono','Fira Code',monospace", animation: "fadeSlideIn .18s ease-out",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex", alignItems: "flex-start", justifyContent: "space-between",
        padding: "14px 16px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)",
        background: `linear-gradient(135deg, ${changeColor}12 0%, transparent 100%)`,
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: "#f1f5f9", letterSpacing: "0.04em" }}>{ticker}</span>
            {data?.currentPrice && <span style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0" }}>{data.currentPrice}</span>}
            {change !== undefined && (
              <span style={{ fontSize: 11, fontWeight: 700, color: changeColor, background: changeColor + "18", border: `1px solid ${changeColor}44`, borderRadius: 5, padding: "1px 7px" }}>
                {pos ? "+" : ""}{change}%
              </span>
            )}
          </div>
          {data?.name && data.name !== ticker && <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>{data.name}</div>}
        </div>
        
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {data?.earningsDate && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(192,132,252,0.12)", border: "1px solid rgba(192,132,252,0.3)", padding: "4px 8px", borderRadius: 6 }}>
              <span style={{ fontSize: 9, fontWeight: 800, color: "#c084fc", letterSpacing: "0.05em" }}>EARNINGS:</span>
              <span style={{ fontSize: 9, fontWeight: 700, color: "#e2e8f0" }}>
                {new Date(data.earningsDate * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
              </span>
            </div>
          )}
          {!loading && data && (
            <button
              onClick={runAnalysis}
              disabled={analysisLoading}
              title="Run 3-agent AI analysis (Fundamentals · Technical · Macro)"
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: analysisLoading ? "rgba(96,165,250,0.05)" : "rgba(96,165,250,0.12)",
                border: "1px solid rgba(96,165,250,0.35)",
                borderRadius: 6, padding: "4px 10px",
                color: analysisLoading ? "#475569" : "#60a5fa",
                cursor: analysisLoading ? "default" : "pointer",
                fontSize: 9, fontWeight: 800, letterSpacing: "0.08em",
                textTransform: "uppercase", fontFamily: "inherit",
                transition: "all .15s",
              }}
            >
              {analysisLoading
                ? <><span style={{ display: "inline-block", animation: "spin 0.8s linear infinite" }}>⟳</span> Analyzing…</>
                : "⚡ Run Analysis"}
            </button>
          )}
          {analysisError && (
            <span style={{ fontSize: 9, color: "#f87171", maxWidth: 160, whiteSpace: "normal", lineHeight: 1.3, textAlign: "right" }}>
              ⚠ {analysisError.length > 80 ? analysisError.slice(0, 80) + "…" : analysisError}
            </span>
          )}
          <button onClick={onClose} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#64748b", width: 24, height: 24, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>×</button>
        </div>
      </div>

      <div style={{ padding: "12px 16px 14px" }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 80, color: "#475569", fontSize: 12 }}>Loading…</div>
        ) : !data ? (
          <div style={{ color: "#475569", fontSize: 12, textAlign: "center", padding: "20px 0" }}>No data available for {ticker}</div>
        ) : (
          <div style={{ display: "flex", gap: 20 }}>
            
            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              {(data.sector !== "—" || data.industry !== "—") && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {data.sector !== "—" && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.25)", color: "#60a5fa" }}>{data.sector}</span>}
                  {data.industry !== "—" && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8" }}>{data.industry}</span>}
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px", marginBottom: 12 }}>
                {[
                  { label: "Market Cap", value: data.marketCap },
                  { label: "P/E Ratio",  value: data.peRatio },
                  { label: "52W Low",    value: data.week52Low },
                  { label: "52W High",   value: data.week52High },
                  { label: "Employees",  value: data.employees },
                  { label: "Country",    value: data.country },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 1 }}>{label}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{value}</div>
                  </div>
                ))}
              </div>

              {data.description && (
                <div style={{ fontSize: 10.5, color: "#94a3b8", lineHeight: 1.55, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 10, overflowY: "auto", maxHeight: 130, paddingRight: 6 }}>
                  {data.description}
                </div>
              )}
              {data.website && (
                <a href={data.website} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: "auto", paddingTop: 8, fontSize: 10, color: "#60a5fa", textDecoration: "none", opacity: 0.7 }} onMouseEnter={e => e.currentTarget.style.opacity = "1"} onMouseLeave={e => e.currentTarget.style.opacity = "0.7"}>
                  {data.website.replace(/^https?:\/\//, "")} ↗
                </a>
              )}
            </div>

            <div style={{ width: 220, display: "flex", flexDirection: "column", flexShrink: 0 }}>
              
              {data.news && (
                <div style={{ marginBottom: 14, padding: "8px 10px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 9, color: "#94a3b8", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>🗞 Latest News</span>
                    <a href={data.news.link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 9, color: "#60a5fa", textDecoration: "none", fontWeight: 600, background: "rgba(96,165,250,0.15)", padding: "2px 6px", borderRadius: 4 }}>
                      Read ↗
                    </a>
                  </div>
                  <div style={{ fontSize: 11, color: "#e2e8f0", lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", fontWeight: 500 }} title={data.news.title}>
                    {data.news.title}
                  </div>
                  {data.news.publisher && (
                    <div style={{ fontSize: 9, color: "#475569", marginTop: 4, fontFamily: "'Inter', sans-serif" }}>via {data.news.publisher}</div>
                  )}
                </div>
              )}

              {data.chartData && data.chartData.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <div style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase" }}>1-Month Trend</div>
                  {monthChangePct !== null && (
                    <div style={{ fontSize: 10, fontWeight: 700, color: chartColor, background: chartColor + "15", padding: "1px 6px", borderRadius: 4, border: `1px solid ${chartColor}44` }}>
                      {monthChangePct >= 0 ? "+" : ""}{monthChangePct.toFixed(2)}%
                    </div>
                  )}
                </div>
              )}
              
              <div style={{ marginTop: "auto", marginBottom: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
                {data.chartData && data.chartData.length > 0 && (
                  <div><MiniChart data={data.chartData} dates={data.chartDates} color={chartColor} ticker={ticker} /></div>
                )}
                {data.raw52Low != null && data.raw52High != null && data.rawPrice != null && (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#475569", marginBottom: 6, fontFamily: "monospace" }}>
                      <span>{data.week52Low}</span>
                      <span style={{ color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em" }}>52W Range</span>
                      <span>{data.week52High}</span>
                    </div>
                    <div style={{ position: "relative", height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2 }}>
                      <div style={{ position: "absolute", left: `${Math.max(0, Math.min(100, (data.raw52High - data.raw52Low) > 0 ? ((data.rawPrice - data.raw52Low) / (data.raw52High - data.raw52Low)) * 100 : 50))}%`, top: "50%", transform: "translate(-50%, -50%)", width: 8, height: 8, borderRadius: "50%", background: chartColor, boxShadow: `0 0 8px ${chartColor}88` }} />
                    </div>
                  </div>
                )}
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}

// ── TICKER CHIP ───────────────────────────────────────────
// ── HEAT MAP ──────────────────────────────────────────────
function getNear52WLowInfo(priceEntry) {
  if (!priceEntry) return null;
  const { price, week52Low } = priceEntry;
  if (price == null || week52Low == null || week52Low <= 0) return null;
  const pctAboveLow = ((price - week52Low) / week52Low) * 100;
  if (pctAboveLow >= 0 && pctAboveLow <= 25) {
    return { raw52Low: week52Low };
  }
  return null;
}

function getNear52WHighInfo(priceEntry) {
  if (!priceEntry) return null;
  const { price, week52High } = priceEntry;
  if (price == null || week52High == null || week52High <= 0) return null;
  const pctBelowHigh = ((week52High - price) / week52High) * 100;
  if (pctBelowHigh >= 0 && pctBelowHigh <= 10) {
    return { raw52High: week52High };
  }
  return null;
}

function getATHInfo(priceEntry) {
  if (!priceEntry) return null;
  const { price, week52High } = priceEntry;
  if (price == null || week52High == null || week52High <= 0) return null;
  if (price >= week52High * 0.999) {
    return { raw52High: week52High };
  }
  return null;
}

function HeatMap({ prices, capexData, onTickerClick, timeline, setTimeline, isAdmin, shortList = [], onSaveShortlist, activeFilter, setActiveFilter }) {
  const isMobile = useMobile();
  const [tooltip, setTooltip] = useState(null);

  const trackCells = useMemo(() =>
    capexData.tracks.map(track => ({
      track,
      cells: [...new Set(track.subsectors.flatMap(s => s.tickers))],
    })).filter(({ cells }) => cells.length > 0),
  [capexData]);

  function getHeatColor(change) {
    if (typeof change !== 'number') return "rgba(255,255,255,0.04)";
    if (change >= 15) return "#064e3b";
    if (change >= 8)  return "#065f46";
    if (change >= 4)  return "#047857";
    if (change >= 1)  return "#059669";
    if (change >= 0)  return "#10b981";
    if (change >= -1) return "#ef4444";
    if (change >= -4) return "#dc2626";
    if (change >= -8) return "#b91c1c";
    return "#7f1d1d";
  }

  return (
    <div style={{ borderRadius: 18, border: "1px solid rgba(255,255,255,0.07)", background: "rgba(24,24,24,0.7)", padding: isMobile ? "12px 8px" : 20, height: "100%", overflowX: "hidden", boxSizing: "border-box", width: "100%" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", margin: 0 }}>Portfolio Heat Map</h3>
            <div style={{ display: "flex", background: "rgba(255,255,255,0.05)", borderRadius: 6, padding: 2 }}>
              {["1D", "5D", "1M", "6M", "YTD", "1Y"].map(t => (
                <button key={t} onClick={() => setTimeline(t)} style={{
                  background: timeline === t ? "rgba(255,255,255,0.1)" : "transparent",
                  color: timeline === t ? "#e2e8f0" : "#64748b",
                  border: "none", borderRadius: 4, padding: "2px 8px",
                  fontSize: 10, fontWeight: timeline === t ? 700 : 500,
                  cursor: "pointer", transition: "all .15s"
                }}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 10, color: "#64748b" }}>
            {[
              { id: "near52WLow", label: "within 25% of 52W low", icon: <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "rgba(251,191,36,0.25)", border: "1px solid #f59e0b", boxShadow: "0 0 6px #f59e0b88", flexShrink: 0 }} /> },
              { id: "near52WHigh", label: "within 10% of 52W high", icon: <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "rgba(52,211,153,0.25)", border: "1px solid #34d399", boxShadow: "0 0 6px #34d39988", flexShrink: 0 }} /> },
              { id: "ath", label: "All Time High (ATH)", icon: <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "rgba(52,211,153,0.35)", border: "2.5px solid #34d399", boxShadow: "0 0 8px #34d399cc", flexShrink: 0 }} /> },
              { id: "earnings", label: "Earnings in 3 Days", icon: <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 10, height: 10, borderRadius: 2, background: "rgba(192,132,252,0.25)", border: "1px solid #c084fc", color: "#c084fc", fontSize: 7, fontWeight: 800, flexShrink: 0 }}>E</span> },
              { id: "starred", label: "Wizzle's Holdings", icon: <span style={{ display: "inline-block", color: "#facc15", fontSize: 11, lineHeight: 1, textShadow: "0 0 6px #facc1588", flexShrink: 0 }}>★</span> }
            ].map(f => (
              <button
                key={f.id}
                onClick={() => setActiveFilter(prev => prev === f.id ? null : f.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  background: activeFilter === f.id ? "rgba(255,255,255,0.1)" : "transparent",
                  border: "1px solid",
                  borderColor: activeFilter === f.id ? "rgba(255,255,255,0.2)" : "transparent",
                  padding: "4px 8px",
                  borderRadius: 6,
                  color: activeFilter === f.id ? "#e2e8f0" : "#64748b",
                  cursor: "pointer",
                  transition: "all 0.15s",
                  outline: "none",
                  fontFamily: "inherit",
                  fontSize: 10,
                }}
              >
                {f.icon}
                <span>{f.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {trackCells.map(({ track, cells }) => {
        const filteredCells = cells.filter(ticker => {
          if (!activeFilter) return true;
          const entry = prices[ticker];
          const near52W = getNear52WLowInfo(entry);
          const athInfo = !near52W ? getATHInfo(entry) : null;
          const near52WH = !near52W && !athInfo ? getNear52WHighInfo(entry) : null;
          const earningsDate = entry?.earningsDate;
          const isUpcomingEarnings = earningsDate && (earningsDate * 1000 - Date.now() <= 3 * 86400000) && (earningsDate * 1000 - Date.now() >= -86400000);
          const isStarred = shortList.includes(ticker);

          if (activeFilter === "near52WLow") return !!near52W;
          if (activeFilter === "near52WHigh") return !!near52WH;
          if (activeFilter === "ath") return !!athInfo;
          if (activeFilter === "earnings") return !!isUpcomingEarnings;
          if (activeFilter === "starred") return isStarred;
          return true;
        });

        if (filteredCells.length === 0) return null;

        return (
          <div key={track.id} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: track.color, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: 7, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: track.color, flexShrink: 0 }} />
              {track.label}
              <div style={{ flex: 1, height: 1, background: `linear-gradient(90deg,${track.color}44,transparent)` }} />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: isMobile ? 4 : 6, minHeight: 40 }}>
              {filteredCells.map(ticker => {
                const entry = prices[ticker];
                const change = getChangeForTimeline(entry, timeline);
                const currentPrice = entry?.price;
                const session = entry?.session;
                const sessionLabel = session === "POST" || session === "CLOSED" ? "AH" : session === "PRE" ? "PM" : null;
                const bg = getHeatColor(change);
                const pos = change === undefined || change >= 0;
                const near52W = getNear52WLowInfo(entry);
                const athInfo = !near52W ? getATHInfo(entry) : null;
                const near52WH = !near52W && !athInfo ? getNear52WHighInfo(entry) : null;
                
                const earningsDate = entry?.earningsDate;
                const isUpcomingEarnings = earningsDate && (earningsDate * 1000 - Date.now() <= 3 * 86400000) && (earningsDate * 1000 - Date.now() >= -86400000);

                const isStarred = shortList.includes(ticker);
                const showStar = isStarred || isAdmin;

                return (
                  <div key={ticker}
                    onMouseEnter={e => setTooltip({ ticker, change, price: currentPrice, session: sessionLabel, track: track.label, near52W, near52WH, athInfo, isUpcomingEarnings, rect: e.currentTarget.getBoundingClientRect() })}
                    onMouseLeave={() => setTooltip(null)}
                    onClick={e => { e.stopPropagation(); onTickerClick?.(ticker, e.currentTarget.getBoundingClientRect()); }}
                    style={{
                      position: "relative",
                      background: near52W
                        ? `linear-gradient(135deg, ${bg} 60%, rgba(245,158,11,0.18) 100%)`
                        : athInfo
                        ? `linear-gradient(135deg, ${bg} 60%, rgba(52,211,153,0.28) 100%)`
                        : near52WH
                        ? `linear-gradient(135deg, ${bg} 60%, rgba(52,211,153,0.18) 100%)`
                        : bg,
                      borderRadius: 8,
                      padding: "8px 12px",
                      height: 48,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "center",
                      alignItems: "center",
                      border: near52W
                        ? "1px solid #f59e0b"
                        : athInfo
                        ? "2.5px solid #34d399"
                        : near52WH
                        ? "1px solid #34d399"
                        : `1px solid ${bg === "rgba(255,255,255,0.04)" ? "rgba(255,255,255,0.06)" : bg}`,
                      boxShadow: near52W
                        ? "0 0 10px rgba(245,158,11,0.45), inset 0 0 12px rgba(245,158,11,0.08)"
                        : athInfo
                        ? "0 0 14px rgba(52,211,153,0.65), inset 0 0 16px rgba(52,211,153,0.12)"
                        : near52WH
                        ? "0 0 10px rgba(52,211,153,0.45), inset 0 0 12px rgba(52,211,153,0.08)"
                        : "none",
                      animation: near52W
                        ? "glowPulse52W 2.4s ease-in-out infinite"
                        : athInfo
                        ? "glowPulseATH 2.4s ease-in-out infinite"
                        : near52WH
                        ? "glowPulse52WH 2.4s ease-in-out infinite"
                        : "none",
                      minWidth: 52,
                      textAlign: "center",
                      cursor: "pointer",
                      transition: "filter .15s, transform .15s",
                    }}
                    onMouseOver={e => { e.currentTarget.style.filter = "brightness(1.4)"; e.currentTarget.style.transform = "scale(1.06)"; }}
                    onMouseOut={e => { e.currentTarget.style.filter = ""; e.currentTarget.style.transform = ""; }}>
                    
                    {isUpcomingEarnings && (
                      <div style={{ position: "absolute", top: 3, left: 4, fontSize: 8, fontWeight: 800, color: "#c084fc", letterSpacing: "0.05em", lineHeight: 1 }}>E</div>
                    )}

                    {sessionLabel && !near52W && !athInfo && !near52WH && (
                      <div style={{ position: "absolute", top: 3, right: 4, fontSize: 7, fontWeight: 800, color: "rgba(255,255,255,0.55)", letterSpacing: "0.05em", lineHeight: 1 }}>{sessionLabel}</div>
                    )}
                    {near52W && (
                      <div style={{ position: "absolute", top: 3, right: 4, fontSize: 7, fontWeight: 800, color: "#f59e0b", letterSpacing: "0.05em", lineHeight: 1 }}>▼52W</div>
                    )}
                    {athInfo && (
                      <div style={{ position: "absolute", top: 3, right: 4, fontSize: 7, fontWeight: 800, color: "#34d399", letterSpacing: "0.05em", lineHeight: 1 }}>ATH</div>
                    )}
                    {near52WH && (
                      <div style={{ position: "absolute", top: 3, right: 4, fontSize: 7, fontWeight: 800, color: "#34d399", letterSpacing: "0.05em", lineHeight: 1 }}>▲52W</div>
                    )}
                    <div style={{ fontSize: 12, fontWeight: 700, color: near52W ? "#fef3c7" : (athInfo || near52WH) ? "#d1fae5" : "#f1f5f9" }}>{ticker}</div>
                    {change !== undefined ? (
                      <div style={{ fontSize: 10, fontWeight: 600, color: pos ? "#a7f3d0" : "#fca5a5", marginTop: 2 }}>
                        {typeof change === 'number' ? (change >= 0 ? "+" : "") + change.toFixed(2) + "%" : "—"}
                      </div>
                    ) : (
                      <div style={{ fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>—</div>
                    )}
                    {showStar && (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isAdmin) {
                            if (isStarred) {
                              onSaveShortlist(shortList.filter(t => t !== ticker));
                            } else {
                              onSaveShortlist([...shortList, ticker]);
                            }
                          }
                        }}
                        style={{
                          position: "absolute", bottom: 4, left: 5,
                          fontSize: 10, lineHeight: 1,
                          color: isStarred ? "#facc15" : "rgba(255,255,255,0.3)",
                          cursor: isAdmin ? "pointer" : "default",
                          zIndex: 2,
                        }}
                      >
                        {isStarred ? "★" : "☆"}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      
      {tooltip && (
        <div style={{ position: "fixed", top: tooltip.rect.top - (tooltip.near52W || tooltip.near52WH || tooltip.athInfo || tooltip.isUpcomingEarnings ? 68 : 52), left: tooltip.rect.left, background: "rgba(18,18,18,0.95)", border: `1px solid ${tooltip.near52W ? "#f59e0b" : tooltip.near52WH ? "#34d399" : (tooltip.change ?? 0) >= 0 ? "#34d399" : "#f87171"}44`, borderRadius: 8, padding: "7px 12px", pointerEvents: "none", zIndex: 1000, display: "flex", flexDirection: "column", gap: 4, minWidth: 140 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#f1f5f9" }}>{tooltip.ticker}</span>
            {tooltip.price !== undefined && <span style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>${tooltip.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
            {tooltip.change !== undefined && <span style={{ fontSize: 12, fontWeight: 700, color: (tooltip.change ?? 0) >= 0 ? "#34d399" : "#f87171" }}>{typeof tooltip.change === 'number' ? (tooltip.change >= 0 ? "+" : "") + tooltip.change.toFixed(2) + "%" : "—"}</span>}
            {tooltip.session && <span style={{ fontSize: 9, fontWeight: 700, color: "#64748b", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 3, padding: "1px 5px", letterSpacing: "0.05em" }}>{tooltip.session}</span>}
            <span style={{ fontSize: 10, color: "#475569" }}>{tooltip.track}</span>
          </div>
          
          {tooltip.isUpcomingEarnings && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 8, fontWeight: 800, color: "#c084fc", background: "rgba(192,132,252,0.15)", border: "1px solid rgba(192,132,252,0.4)", borderRadius: 3, padding: "1px 5px", letterSpacing: "0.08em" }}>E EARNINGS SOON</span>
              <span style={{ fontSize: 10, color: "#c084fc" }}>Within 3 Days</span>
            </div>
          )}

          {tooltip.near52W && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 8, fontWeight: 800, color: "#f59e0b", background: "rgba(245,158,11,0.15)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 3, padding: "1px 5px", letterSpacing: "0.08em" }}>▼ 52W LOW ZONE</span>
              <span style={{ fontSize: 10, color: "#f59e0b" }}>within 25% of ${Number(tooltip.near52W.raw52Low).toFixed(2)}</span>
            </div>
          )}
          {tooltip.near52WH && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 8, fontWeight: 800, color: "#34d399", background: "rgba(52,211,153,0.15)", border: "1px solid rgba(52,211,153,0.4)", borderRadius: 3, padding: "1px 5px", letterSpacing: "0.08em" }}>▲ 52W HIGH ZONE</span>
              <span style={{ fontSize: 10, color: "#34d399" }}>within 10% of ${Number(tooltip.near52WH.raw52High).toFixed(2)}</span>
            </div>
          )}
          {tooltip.athInfo && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 8, fontWeight: 800, color: "#34d399", background: "rgba(52,211,153,0.2)", border: "1.5px solid rgba(52,211,153,0.6)", borderRadius: 3, padding: "1px 5px", letterSpacing: "0.08em" }}>🏆 ALL TIME HIGH</span>
              <span style={{ fontSize: 10, color: "#34d399", fontWeight: 700 }}>ATH: ${Number(tooltip.athInfo.raw52High).toFixed(2)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── WATCHLIST ─────────────────────────────────────────────
function Watchlist({ prices, capexData, onTickerClick, isAdmin, shortList, onSaveShortlist, timeline, activeFilter }) {
  const isMobile = useMobile();
  const [tab, setTab]         = useState("watch");
  const [input, setInput]     = useState("");
  const [sortDir, setSortDir] = useState("desc");
  const [filter, setFilter]   = useState("all");

  const isShort = tab === "short";
  const accent  = isShort ? "#f59e0b" : "#60a5fa";

  const watchList = useMemo(
    () => [...new Set(capexData.tracks.flatMap(t => t.subsectors.flatMap(s => s.tickers)))],
    [capexData]
  );

  const list = isShort ? shortList : watchList;

  function switchTab(t) { setTab(t); setFilter("all"); setInput(""); }

  function addTicker(sym) {
    if (!sym || shortList.includes(sym)) return;
    onSaveShortlist([...shortList, sym]);
  }
  function removeTicker(sym) {
    onSaveShortlist(shortList.filter(x => x !== sym));
  }

  function handleAdd() {
    const sym = input.trim().toUpperCase();
    if (sym) { addTicker(sym); setInput(""); }
  }

  const sectorMap = useMemo(() => {
    const map = {};
    for (const track of capexData.tracks)
      for (const sub of track.subsectors)
        for (const t of sub.tickers) map[t] = track;
    return map;
  }, [capexData]);

  const TRACK_SHORT = { compute: "Compute", networking: "Network", photonics: "Photonics", neoclouds: "Data Ctr", power: "Power", frontier: "Frontier" };

  const enriched = list.map(t => ({ ticker: t, change: getChangeForTimeline(prices[t], timeline), track: sectorMap[t] ?? null }));
  let filtered   = filter === "all" ? enriched : enriched.filter(x => x.track?.id === filter);

  if (activeFilter) {
    filtered = filtered.filter(item => {
      const entry = prices[item.ticker];
      const near52W = getNear52WLowInfo(entry);
      const athInfo = !near52W ? getATHInfo(entry) : null;
      const near52WH = !near52W && !athInfo ? getNear52WHighInfo(entry) : null;
      const earningsDate = entry?.earningsDate;
      const isUpcomingEarnings = earningsDate && (earningsDate * 1000 - Date.now() <= 3 * 86400000) && (earningsDate * 1000 - Date.now() >= -86400000);
      const isStarred = shortList.includes(item.ticker);

      if (activeFilter === "near52WLow") return !!near52W;
      if (activeFilter === "near52WHigh") return !!near52WH;
      if (activeFilter === "ath") return !!athInfo;
      if (activeFilter === "earnings") return !!isUpcomingEarnings;
      if (activeFilter === "starred") return isStarred;
      return true;
    });
  }

  const sorted       = [...filtered].sort((a, b) => sortDir === "desc"
    ? ((typeof b.change === 'number' ? b.change : -999) - (typeof a.change === 'number' ? a.change : -999))
    : ((typeof a.change === 'number' ? a.change : 999)  - (typeof b.change === 'number' ? b.change : 999)));
  const validChanges = filtered.filter(x => typeof x.change === 'number');
  const avg          = validChanges.reduce((s, x) => s + x.change, 0) / (validChanges.length || 1);

  return (
    <div style={{ borderRadius: 18, border: "1px solid rgba(255,255,255,0.07)", background: "rgba(24,24,24,0.7)", padding: isMobile ? "12px 8px" : 20, display: "flex", flexDirection: "column", gap: 14, height: "100%", boxSizing: "border-box", width: "100%", overflowX: "hidden" }}>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", gap: 2, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: 3 }}>
          {[["watch","👁 Watchlist"],["short","⭐ Shortlist"]].map(([id, label]) => (
            <button key={id} onClick={() => switchTab(id)} style={{
              background: tab === id ? (id === "short" ? "rgba(245,158,11,0.15)" : "rgba(96,165,250,0.12)") : "transparent",
              border: `1px solid ${tab === id ? (id === "short" ? "rgba(245,158,11,0.35)" : "rgba(96,165,250,0.25)") : "transparent"}`,
              color: tab === id ? (id === "short" ? "#f59e0b" : "#60a5fa") : "#475569",
              borderRadius: 7, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
              fontWeight: tab === id ? 700 : 400, transition: "all .15s",
            }}>{label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
          <div style={{ textAlign: "center" }}><div style={{ color: "#34d399", fontWeight: 700 }}>{filtered.filter(x => (typeof x.change === 'number' ? x.change : -1) >= 0).length}</div><div style={{ color: "#475569", fontSize: 10 }}>UP</div></div>
          <div style={{ textAlign: "center" }}><div style={{ color: "#f87171", fontWeight: 700 }}>{filtered.filter(x => (typeof x.change === 'number' ? x.change : 0) < 0).length}</div><div style={{ color: "#475569", fontSize: 10 }}>DOWN</div></div>
          <div style={{ textAlign: "center" }}><div style={{ color: avg >= 0 ? "#34d399" : "#f87171", fontWeight: 700 }}>{validChanges.length ? (avg >= 0 ? "+" : "") + avg.toFixed(2) + "%" : "—"}</div><div style={{ color: "#475569", fontSize: 10 }}>AVG</div></div>
        </div>
      </div>

      {isShort ? (
        <p style={{ fontSize: 11, color: "#64748b", margin: 0, marginTop: -6 }}>
          Potential investment opportunities · shared with all users
        </p>
      ) : (
        <p style={{ fontSize: 11, color: "#475569", margin: 0, marginTop: -6, display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ color: "#334155" }}>⟳</span> Auto-synced from Portfolio Heat Map
        </p>
      )}

      {isShort && (
        !isAdmin ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 8, padding: "10px 14px" }}>
            <span style={{ fontSize: 14 }}>🔒</span>
            <span style={{ fontSize: 12, color: "#64748b" }}>Login to add or remove tickers from the Shortlist</span>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && handleAdd()}
              placeholder="Add opportunity… e.g. NVDA"
              style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "7px 12px", color: "#e2e8f0", fontSize: 12, fontFamily: "inherit", outline: "none" }}
            />
            <button onClick={handleAdd} style={{ background: `${accent}1a`, border: `1px solid ${accent}40`, color: accent, borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>+ Add</button>
          </div>
        )
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.05)",
            border: `1px solid ${filter === "all" ? "rgba(255,255,255,0.1)" : (capexData.tracks.find(t => t.id === filter)?.color ?? "#60a5fa") + "66"}`,
            borderRadius: 8,
            padding: "5px 10px",
            color: filter === "all" ? "#e2e8f0" : (capexData.tracks.find(t => t.id === filter)?.color ?? "#e2e8f0"),
            fontSize: 11,
            fontFamily: "inherit",
            cursor: "pointer",
            outline: "none",
            appearance: "none",
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2364748b'/%3E%3C/svg%3E")`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "right 10px center",
            paddingRight: 28,
          }}
        >
          <option value="all" style={{ background: "#1e293b", color: "#e2e8f0" }}>All Sectors</option>
          {capexData.tracks.map(track => {
            const label = TRACK_SHORT[track.id] ?? track.label.split(" ")[0];
            return (
              <option key={track.id} value={track.id} style={{ background: "#1e293b", color: "#e2e8f0" }}>{label}</option>
            );
          })}
        </select>
        <button onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")} style={{ flexShrink: 0, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#64748b", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>Sort {sortDir === "desc" ? "↓" : "↑"}</button>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, overflowY: "auto", minHeight: 0, paddingRight: 4 }}>
        {sorted.length === 0 && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "#334155", fontSize: 12 }}>
            <span style={{ fontSize: 28 }}>{isShort ? "⭐" : "👁"}</span>
            <span>{isShort ? "Add tickers you're watching for entry" : "No tickers match this filter"}</span>
          </div>
        )}
        {sorted.map((item, idx) => {
          const pos  = (typeof item.change === 'number' ? item.change : 0) >= 0;
          const pData = prices[item.ticker] || {};
          const w52L = pData.week52Low;
          const w52H = pData.week52High;
          const pLive = pData.price;
          const has52W = w52L != null && w52H != null && pLive != null && (w52H > w52L);
          const dotPos = has52W ? Math.max(0, Math.min(100, ((pLive - w52L) / (w52H - w52L)) * 100)) : 50;
          const dotColor = pos ? "#34d399" : "#f87171";

          return (
            <div key={item.ticker} style={{ borderRadius: 8, padding: "10px 10px", display: "flex", alignItems: "center", gap: isMobile ? 6 : 10, borderBottom: "1px solid rgba(255,255,255,0.04)", transition: "background .15s" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.04)"}
              onMouseLeave={e => e.currentTarget.style.background = ""}>
              <span style={{ fontSize: 10, color: "#334155", width: 16, textAlign: "right", flexShrink: 0 }}>{idx + 1}</span>
              <div style={{ flex: "0 0 auto", minWidth: isMobile ? 46 : 60, cursor: "pointer" }} onClick={e => onTickerClick?.(item.ticker, e.currentTarget.getBoundingClientRect())}>
                <div style={{ fontSize: isMobile ? 11 : 13, fontWeight: 700, color: "#f1f5f9" }}>{item.ticker}</div>
                {item.track
                  ? <div style={{ fontSize: 9, color: item.track.color, marginTop: 1 }}>{item.track.label.split(" ").slice(0,2).join(" ")}</div>
                  : isShort && <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 1 }}>Shortlist</div>
                }
              </div>

              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, fontFamily: "monospace", minWidth: isMobile ? 60 : 100 }}>
                {has52W ? (
                  <>
                    <div style={{ position: "relative", height: 14 }}>
                      <div style={{
                        position: "absolute",
                        left: `clamp(0%, ${dotPos}%, 100%)`,
                        top: 0, bottom: 0,
                        display: "flex", alignItems: "center",
                        transform: dotPos < 10
                          ? "translateX(0%)"
                          : dotPos > 90
                          ? "translateX(-100%)"
                          : "translateX(-50%)",
                      }}>
                        <span style={{
                          fontSize: 8.5, fontWeight: 700, color: "#e2e8f0",
                          whiteSpace: "nowrap",
                          background: "rgba(24,24,24,0.85)", padding: "1px 4px", borderRadius: 3,
                        }}>${pLive.toFixed(2)}</span>
                      </div>
                    </div>
                    <div style={{ position: "relative", height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2 }}>
                      <div style={{ position: "absolute", left: `${dotPos}%`, top: "50%", transform: "translate(-50%,-50%)", width: 8, height: 8, borderRadius: "50%", background: dotColor, boxShadow: `0 0 6px ${dotColor}88` }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8, color: "#475569", marginTop: 1 }}>
                      <span>{w52L}</span>
                      <span>{w52H}</span>
                    </div>
                  </>
                ) : (
                  <span style={{ textAlign: "center", color: "#475569", fontSize: 9 }}>—</span>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4, fontSize: isMobile ? 11 : 13, fontWeight: 700, minWidth: isMobile ? 54 : 68, textAlign: "right", flexShrink: 0, color: typeof item.change !== 'number' ? "#334155" : pos ? "#34d399" : "#f87171" }}>
                {typeof item.change !== 'number' ? "—" : <><span style={{ fontSize: 10 }}>{pos ? "▲" : "▼"}</span>{Math.abs(item.change).toFixed(2)}%</>}
              </div>
              <button onClick={() => removeTicker(item.ticker)} style={{ background: "none", border: "none", color: "#1e293b", cursor: "pointer", fontSize: 16, padding: "0 2px", lineHeight: 1, transition: "color .15s", fontFamily: "inherit", visibility: !isShort || !isAdmin ? "hidden" : "visible", flexShrink: 0 }} onMouseEnter={e => e.currentTarget.style.color = "#ef4444"} onMouseLeave={e => e.currentTarget.style.color = "#1e293b"}>×</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── PRE-MARKET GAP SCANNER PANEL ──────────────────────────
const TJL_BADGES = {
  PASS:          { label: "PASS",     color: "#34d399", title: "Trend Join Long: daily breakout + intraday breakout confirmed" },
  fail_daily:    { label: "FAIL · D", color: "#f87171", title: "Failed daily leg: below prev daily high or close under 200 SMA" },
  fail_intraday: { label: "FAIL · I", color: "#fbbf24", title: "Failed intraday leg: below premarket high or high-of-day" },
};

function GapScannerPanel({ prices, onTickerClick }) {
  const isMobile = useMobile();
  const [scan, setScan]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const fetchScan = async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/gap-scanner");
      const json = await res.json();
      if (json.success && json.data?.gappers?.length > 0) {
        setScan(json.data);
      } else {
        setError(json.message || "No gap scan available yet.");
        setScan(null);
      }
    } catch (err) {
      setError("Could not reach gap-scanner API. Check your Cloudflare deployment.");
      setScan(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchScan(); }, []);

  const scannedAgo = scan?.scanned_at
    ? (() => {
        const diffMin = Math.floor((Date.now() - new Date(scan.scanned_at).getTime()) / 60000);
        if (diffMin >= 60) return `${Math.floor(diffMin / 60)}h ${diffMin % 60}m ago`;
        if (diffMin >= 1) return `${diffMin}m ago`;
        return "just now";
      })()
    : null;

  const passCount = scan?.gappers?.filter(g => g.tjl?.result === "PASS").length ?? 0;
  const fmtVol = v => v == null ? "—" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : String(v);

  return (
    <div style={{ borderRadius: 18, border: "1px solid rgba(255,255,255,0.07)", background: "rgba(24,24,24,0.7)", padding: isMobile ? "12px 8px" : 20, display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box", width: "100%", overflowX: "hidden" }}>

      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8, flexShrink: 0, minWidth: 0 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: "#fbbf24" }}>Pre-market Gap Scanner</h3>
            <span style={{ fontSize: 9, color: "#60a5fa", background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.3)", borderRadius: 4, padding: "2px 7px", fontWeight: 700, letterSpacing: "0.1em" }}>● TJL STRATEGY</span>
            {passCount > 0 && (
              <span style={{ fontSize: 9, color: "#34d399", background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.3)", borderRadius: 4, padding: "2px 7px", fontWeight: 700, letterSpacing: "0.1em" }}>
                {passCount} PASS{passCount > 1 ? "ES" : ""}
              </span>
            )}
          </div>
          <p style={{ fontSize: 11, color: "#475569", marginTop: 3 }}>
            Gap &gt;5% · price &gt;$3 · vol &gt;25K · Trend Join Long: above prev daily high, 200 SMA, PMH &amp; HOD
            {scannedAgo ? ` · scanned ${scannedAgo}` : ""}
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => fetchScan()}
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#64748b", borderRadius: 8, padding: "6px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", overflowX: "auto", minHeight: 400, paddingRight: isMobile ? 0 : 4, WebkitOverflowScrolling: "touch" }}>
        {error && (
          <div style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#94a3b8", fontSize: 12 }}>⚠ {error}</div>
        )}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: isMobile ? 10 : 11, textAlign: "left" }}>
          <thead>
            <tr style={{ color: "#475569", borderBottom: "1px solid rgba(255,255,255,0.05)", position: "sticky", top: 0, background: "rgba(14,17,23,0.95)", zIndex: 10 }}>
              {['#','TICKER','PRICE','GAP %','PM VOL','CATALYST','PREV HIGH','SMA200','PMH','HOD'].map(h => <th key={h} style={{ padding: isMobile ? '6px 4px' : '10px 8px', whiteSpace: 'nowrap' }}>{h}</th>)}
              <th style={{ padding: isMobile ? '6px 4px' : '10px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>TJL</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="11" style={{ padding: 20, color: "#475569" }}>
                Loading gap scan…
              </td></tr>
            ) : !scan?.gappers?.length ? (
              <tr><td colSpan="11" style={{ padding: 20, color: "#475569" }}>
                No gappers today (or the morning pipeline hasn't pushed yet).
              </td></tr>
            ) : scan.gappers.map(g => {
              const priceEntry = prices[g.symbol];
              const livePrice  = priceEntry?.price ?? g.tjl?.curr_price ?? g.price;
              const change     = priceEntry?.change;
              const tjl        = g.tjl || {};
              const badge      = TJL_BADGES[tjl.result] || { label: "—", color: "#475569", title: "TJL not evaluated" };
              const fmtPx = v => v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

              return (
                <tr key={g.symbol}
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.03)", transition: "background .15s", background: tjl.result === "PASS" ? "rgba(52,211,153,0.05)" : "" }}
                  onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                  onMouseLeave={e => e.currentTarget.style.background = tjl.result === "PASS" ? "rgba(52,211,153,0.05)" : ""}>

                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#334155", fontSize: 10 }}>{g.rank ?? "—"}</td>

                  <td onClick={e => onTickerClick(g.symbol, e.currentTarget.getBoundingClientRect())}
                    style={{ padding: isMobile ? "8px 4px" : "12px 8px", cursor: "pointer" }}>
                    <span style={{ fontWeight: 700, color: "#f1f5f9" }}>{g.symbol}</span>
                    {change !== undefined && (
                      <div style={{ fontSize: 9, color: change >= 0 ? "#34d399" : "#f87171" }}>
                        {change >= 0 ? "+" : ""}{change}%
                      </div>
                    )}
                  </td>

                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#e2e8f0", fontWeight: 600 }}>{fmtPx(livePrice)}</td>
                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#34d399", fontWeight: 700 }}>+{Number(g.gap_pct).toFixed(1)}%</td>
                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#cbd5e1" }}>{fmtVol(g.premarket_volume)}</td>

                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#94a3b8", maxWidth: isMobile ? 120 : 260 }} title={g.catalyst || undefined}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.catalyst || "—"}</div>
                  </td>

                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#cbd5e1" }}>{fmtPx(tjl.prev_daily_high)}</td>
                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#cbd5e1" }}>{fmtPx(tjl.sma200)}</td>
                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#cbd5e1" }}>{fmtPx(tjl.pmh)}</td>
                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", color: "#cbd5e1" }}>{fmtPx(tjl.today_hod)}</td>

                  <td style={{ padding: isMobile ? "8px 4px" : "12px 8px", textAlign: "right" }}>
                    <span title={badge.title} style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", color: badge.color, background: badge.color + "18", border: `1px solid ${badge.color}55`, borderRadius: 4, padding: "2px 8px", whiteSpace: "nowrap" }}>
                      {badge.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── GLOBAL STYLES ─────────────────────────────────────────
const GLOBAL_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; box-shadow: none !important; }
  html, body { background: #1a1a1f; font-family: 'Inter', sans-serif; max-width: 100vw; overflow-x: hidden; }
  img, svg, video, table { max-width: 100%; }
  :root { --topbar-h: 72px; }
  @media (max-width: 767px) { :root { --topbar-h: 172px; } }
  
  html.light-mode { filter: invert(1) hue-rotate(180deg); }
  
  table, .market-strip span, .ticker-tape, .capex-number { font-family: 'Roboto Condensed', sans-serif !important; letter-spacing: 0.02em; }
  div[style*="border-radius: 12px"], div[style*="border-radius: 14px"], div[style*="border-radius: 18px"], div[style*="border-radius: 22px"] { border-radius: 6px !important; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 4px; }
  @keyframes scroll-left { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
  @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes glowPulse52W {
    0%, 100% { box-shadow: 0 0 10px rgba(245,158,11,0.45), inset 0 0 12px rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.7); }
    50% { box-shadow: 0 0 18px rgba(245,158,11,0.75), 0 0 32px rgba(245,158,11,0.25), inset 0 0 16px rgba(245,158,11,0.14); border-color: #f59e0b; }
  }
  @keyframes glowPulse52WH {
    0%, 100% { box-shadow: 0 0 10px rgba(52,211,153,0.45), inset 0 0 12px rgba(52,211,153,0.08); border-color: rgba(52,211,153,0.7); }
    50% { box-shadow: 0 0 18px rgba(52,211,153,0.75), 0 0 32px rgba(52,211,153,0.25), inset 0 0 16px rgba(52,211,153,0.14); border-color: #34d399; }
  }
  @keyframes glowPulseATH {
    0%, 100% { box-shadow: 0 0 14px rgba(52,211,153,0.65), inset 0 0 16px rgba(52,211,153,0.12); border-color: rgba(52,211,153,0.85); }
    50% { box-shadow: 0 0 24px rgba(52,211,153,0.9), 0 0 40px rgba(52,211,153,0.35), inset 0 0 20px rgba(52,211,153,0.18); border-color: #34d399; }
  }
  @keyframes pulseDot { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.4; transform:scale(.7); } }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .ticker-tape { animation: scroll-left 200s linear infinite; white-space: nowrap; display: inline-flex; gap: 24px; }
  .pulse { animation: pulseDot 2s infinite; }
  .bottom-grid-all { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .span-2 { grid-column: span 2; }
  .span-1 { grid-column: span 1; }
  .span-3 { grid-column: 1 / -1; }
  .panel-wrapper { position: relative; height: 600px; min-height: 600px; }
  .panel-inner { position: absolute; top: 0; left: 0; right: 0; bottom: 0; }
  .watchlist-wrapper { position: relative; height: 100%; min-height: 400px; }
  .watchlist-inner { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; }
  .panel-tall { height: 850px !important; min-height: 850px !important; }
  @media (max-width: 1024px) { .panel-tall { min-height: 700px !important; height: auto !important; } }
  @media (max-width: 767px) { .panel-tall { min-height: 550px !important; } }
  @media (max-width: 1024px) {
    .bottom-grid-all { grid-template-columns: 1fr !important; }
    .span-2, .span-1 { grid-column: 1 / -1 !important; }
    .panel-wrapper { position: relative; height: auto !important; min-height: unset !important; }
    .panel-inner { position: relative !important; height: auto !important; min-height: 500px; }
    .watchlist-wrapper { position: relative !important; height: auto !important; min-height: 600px; }
    .watchlist-inner { position: relative !important; height: auto !important; }
  }
  @media (max-width: 1100px) {
    .side-panel { display: none !important; }
  }
  @media (max-width: 767px) {
    html, body { overflow-x: hidden; }
    .track-grid { grid-template-columns: repeat(2, minmax(0,1fr)) !important; }
    .top-node-layout { flex-direction: column !important; align-items: stretch !important; gap: 12px !important; }
    .top-node-center { width: 100% !important; max-width: 100% !important; }
    .top-node-center > div:first-child { width: 100% !important; box-sizing: border-box !important; }
    .capex-number { font-size: 44px !important; }
    .subsector-grid { grid-template-columns: 1fr !important; }
    .main-content { padding: 12px 8px !important; max-width: 100vw !important; }
    .header-controls { gap: 8px !important; }
    .panel-wrapper { min-height: 400px; }
    .bottom-grid-all { gap: 10px !important; }
  }
`;

// ── ROOT APP ──────────────────────────────────────────────
export default function App() {
  
  const [isMobileApp, setIsMobileApp] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setIsMobileApp(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [appNotice, setAppNotice] = useState(null);

  // "ai" = hyperscaler capex flow · "musk" = the Musk Galaxy view
  const [view, setView] = useState(() => (window.location.hash === "#musk" ? "musk" : "ai"));
  const isMusk = view === "musk";
  function switchView(next) {
    setView(next);
    setActiveTrack(null);
    window.location.hash = next === "musk" ? "musk" : "";
  }

  const [activeTrack, setActiveTrack] = useState(null);
  const [timeline, setTimeline] = useState("1D");
  const [activeFilter, setActiveFilter] = useState(null);
  const [popup, setPopup] = useState(null);
  const [analysis, setAnalysis] = useState(null); // { ticker, ...analysisResult }

  const {
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
    candidates,
    setCandidates,
    muskCapexData,
    setMuskCapexData,
    muskIntel,
    muskIntelStatus,
    prices,
    pricesRef,
    marketData,
    lastUpdated,
    refreshing,
    refresh,
    capexDataRef,
    scannerPoolRef,
    shortListRef,
  } = useDashboardData({
    defaultScannerPool: DEFAULT_MULTIBAGGER,
    defaultCapexData: CAPEX_DATA,
    defaultMuskData: MUSK_CAPEX_DATA,
    indexTickers: INDEX_TICKERS,
    cryptoTickers: CRYPTO_TICKERS,
    hyperscalerTickers: HYPERSCALER_TICKERS,
    fetchAllPrices,
    getAllTickers,
  });

  const { onlineCount } = usePresence();

  const showNotice = useCallback((message, type = "error") => {
    setAppNotice({ message, type });
  }, []);

  const {
    verifyAdminPassword,
    saveGlobalScanner,
    saveGlobalShortlist,
    saveGlobalCapex,
    saveGlobalMuskCapex,
  } = useAdminActions({
    adminPassword,
    setAdminPassword,
    setIsAdmin,
    setScannerPool,
    setShortList,
    setCapexData,
    setMuskCapexData,
    shortListRef,
    showNotice,
    refresh,
  });

  // Admin map edits operate on whichever view is active.
  const activeMapData = isMusk ? muskCapexData : capexData;
  const saveActiveMap = isMusk ? saveGlobalMuskCapex : saveGlobalCapex;

  useEffect(() => {
    if (!appNotice) return;
    const id = setTimeout(() => setAppNotice(null), 5000);
    return () => clearTimeout(id);
  }, [appNotice]);

  const openPopup = useCallback((ticker, rect) => {
    const change = pricesRef.current[ticker]?.change ?? pricesRef.current[ticker];
    setPopup(prev => (prev?.ticker === ticker ? null : { ticker, change, rect }));
  }, []);

  const handleUnlock = () => setShowAdminModal(true);

  function addTickerToSubsector(trackId, subsectorId, ticker) {
    const sym = ticker.trim().toUpperCase();
    if (!sym) return;
    const newData = {
      ...activeMapData,
      tracks: activeMapData.tracks.map(track =>
        track.id !== trackId ? track : {
          ...track,
          subsectors: track.subsectors.map(sub =>
            sub.id !== subsectorId ? sub : {
              ...sub,
              tickers: sub.tickers.includes(sym) ? sub.tickers : [...sub.tickers, sym],
            }
          ),
        }
      ),
    };
    saveActiveMap(newData);
  }

  function removeTickerFromSubsector(trackId, subsectorId, ticker) {
    const newData = {
      ...activeMapData,
      tracks: activeMapData.tracks.map(track =>
        track.id !== trackId ? track : {
          ...track,
          subsectors: track.subsectors.map(sub =>
            sub.id !== subsectorId ? sub : {
              ...sub,
              tickers: sub.tickers.filter(t => t !== ticker),
            }
          ),
        }
      ),
    };
    saveActiveMap(newData);
  }

  // Bottleneck Scout review: mark the candidate in the DB; on approval also
  // insert the ticker into the capex map (find-or-create the suggested
  // subsector) via the existing admin save flow — that automatically enrolls
  // it in the heat map and the weekly transcript/XBRL scans.
  async function reviewCandidate(candidate, action) {
    try {
      const res = await fetch("/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPassword, ticker: candidate.ticker, action }),
      });
      const json = await res.json();
      if (!json.success) {
        showNotice(json.error || "Review failed");
        return;
      }
      if (action === "approved") {
        // Route the approval into whichever map the candidate was scouted for.
        const isMuskCand = candidate.view === "musk";
        const targetMap = isMuskCand ? muskCapexData : capexData;
        const saveTarget = isMuskCand ? saveGlobalMuskCapex : saveGlobalCapex;
        const trackId = targetMap.tracks.some(t => t.id === candidate.trackId) ? candidate.trackId : "frontier";
        const label = (candidate.suggestedSubsector || "Scout Additions").trim();
        const newData = {
          ...targetMap,
          tracks: targetMap.tracks.map(t => {
            if (t.id !== trackId) return t;
            const existing = t.subsectors.find(s => s.label.toLowerCase() === label.toLowerCase());
            if (existing) {
              return {
                ...t,
                subsectors: t.subsectors.map(s => s.id !== existing.id ? s : {
                  ...s,
                  tickers: s.tickers.includes(candidate.ticker) ? s.tickers : [...s.tickers, candidate.ticker],
                }),
              };
            }
            return {
              ...t,
              subsectors: [...t.subsectors, { id: `scout-${Date.now()}`, label, tickers: [candidate.ticker], materials: [] }],
            };
          }),
        };
        saveTarget(newData);
      }
      // Approved tickers leave the queue immediately (they now live on the
      // map); rejected ones stay briefly, dimmed, as a reminder.
      setCandidates(prev => action === "approved"
        ? prev.filter(c => c.ticker !== candidate.ticker)
        : prev.map(c => c.ticker === candidate.ticker
            ? { ...c, status: action, reviewedAt: new Date().toISOString() }
            : c));
      showNotice(`${candidate.ticker} ${action}${action === "approved" ? " — added to the map" : ""}`, "success");
    } catch (err) {
      showNotice(err.message || "Review failed");
    }
  }

  function addSubsector(trackId) {
    const newId = `sub-${Date.now()}`;
    const newSub = { id: newId, label: "New Sub-Sector", tickers: [], materials: [] };
    const newData = {
      ...activeMapData,
      tracks: activeMapData.tracks.map(t => t.id === trackId ? { ...t, subsectors: [...t.subsectors, newSub] } : t)
    };
    saveActiveMap(newData);
  }

  function removeSubsector(trackId, subId) {
    if (!window.confirm("Are you sure you want to remove this sub-sector?")) return;
    const newData = {
      ...activeMapData,
      tracks: activeMapData.tracks.map(t => t.id === trackId ? { ...t, subsectors: t.subsectors.filter(s => s.id !== subId) } : t)
    };
    saveActiveMap(newData);
  }

  function renameSubsector(trackId, subId, newName) {
    const newData = {
      ...activeMapData,
      tracks: activeMapData.tracks.map(t => t.id === trackId ? {
        ...t,
        subsectors: t.subsectors.map(s => s.id === subId ? { ...s, label: newName } : s)
      } : t)
    };
    saveActiveMap(newData);
  }

  function renameSector(trackId, newName) {
    const newData = {
      ...activeMapData,
      tracks: activeMapData.tracks.map(t => t.id === trackId ? { ...t, label: newName } : t)
    };
    saveActiveMap(newData);
  }

  const allTickerCount = useMemo(() => getAllTickers(capexData).length, [capexData]);

  // Merge grounded intel allocations into a capex map (shared by both views).
  function mergeIntel(mapData, intel) {
    if (!intel?.allocations?.length) return mapData;
    const intelMap = Object.fromEntries(intel.allocations.map(a => [a.id, a]));
    return {
      ...mapData,
      tracks: mapData.tracks.map(track => {
        const t = intelMap[track.id];
        if (!t) return track;
        return {
          ...track,
          capex:           t.capex ?? track.capex,
          value:           t.value || (t.capex ? `~$${t.capex}B` : track.value),
          rationale:       t.rationale,
          intelConfidence: t.confidence,
          isLiveIntel:     true,
        };
      }),
    };
  }

  const liveCapexData = useMemo(() => mergeIntel(capexData, capexIntel), [capexData, capexIntel]);
  const liveMuskData = useMemo(() => mergeIntel(muskCapexData, muskIntel), [muskCapexData, muskIntel]);
  const activeLiveData = isMusk ? liveMuskData : liveCapexData;
  const activeIntelStatus = isMusk ? muskIntelStatus : capexIntelStatus;
  const activeIntel = isMusk ? muskIntel : capexIntel;

  // Aggregate per-ticker transcript stress (GET /stress) up to each subsector:
  // score = avg of member companies' latest scores, trend = avg QoQ delta,
  // companies sorted most-stressed first for the drilldown.
  const subsectorStress = useMemo(() => {
    const out = {};
    if (!stressData || !Object.keys(stressData).length) return out;
    for (const track of activeLiveData.tracks) {
      for (const sub of track.subsectors) {
        const companies = [];
        for (const ticker of sub.tickers) {
          const latest = stressData[ticker]?.latest;
          if (!latest || latest.stressScore == null) continue;
          const prevScore = stressData[ticker]?.prev?.stressScore;
          companies.push({
            ticker,
            score:     latest.stressScore,
            delta:     prevScore != null ? latest.stressScore - prevScore : null,
            direction: latest.direction,
            summary:   latest.summary,
            quotes:    latest.quotes ?? [],
            fy:        latest.fiscalYear,
            fq:        latest.fiscalQuarter,
          });
        }
        if (!companies.length) continue;
        companies.sort((a, b) => b.score - a.score);
        const deltas = companies.filter(c => c.delta != null);
        out[`${track.id}:${sub.id}`] = {
          score: companies.reduce((s, c) => s + c.score, 0) / companies.length,
          trend: deltas.length ? deltas.reduce((s, c) => s + c.delta, 0) / deltas.length : null,
          count: companies.length,
          companies,
        };
      }
    }
    return out;
  }, [stressData, activeLiveData]);

  const liveTotal = useMemo(() => {
    if (activeIntelStatus === "success" && activeIntel?.totalCapexDerived) {
      return activeIntel.totalCapexDerived;
    }
    return activeLiveData.tracks.reduce((s, t) => s + (t.capex || 0), 0);
  }, [activeLiveData, activeIntel, activeIntelStatus]);

  const watchlistTickers = useMemo(() => getAllTickers(activeMapData), [activeMapData]);
  const gainers = watchlistTickers.filter(t => (prices[t]?.change ?? prices[t]) > 0).length;
  const losers  = watchlistTickers.filter(t => (prices[t]?.change ?? prices[t]) < 0).length;
  const activeData = activeLiveData.tracks.find(t => t.id === activeTrack);
  const tickerEntries = Object.entries(prices);

  return (
    <MobileCtx.Provider value={isMobileApp}>
      <style>{GLOBAL_STYLES}</style>
      <div style={{ position: "relative", zIndex: 1, minHeight: "100vh", color: "#fff" }}>
        
        <TopBar marketData={marketData} />
        <StatusBanner notice={appNotice} onDismiss={() => setAppNotice(null)} />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", marginTop: "var(--topbar-h, 72px)", borderBottom: "1px solid rgba(255,255,255,.04)", background: "rgba(24,24,24,0.6)", flexWrap: "wrap", gap: 12 }}>
          
          {/* LEFT SIDE: Title & Controls Stacked */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
  <div style={{ fontSize: 19, fontWeight: 800, color: "#e2e8f0", letterSpacing: "-0.01em" }}>
    AI Capex Flow Intelligence
  </div>
  <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)", padding: "3px 8px", borderRadius: 6 }}>
    <span style={{ 
      width: 6, height: 6, borderRadius: "50%", background: "#34d399", 
      display: "inline-block", boxShadow: "0 0 8px #34d399",
      animation: "pulseDot 2s infinite" 
    }} />
    <span style={{ fontSize: 10, fontWeight: 700, color: "#34d399", letterSpacing: "0.05em", fontFamily: "'DM Mono', monospace" }}>
      {onlineCount} ONLINE
    </span>
  </div>
</div>

            <div className="header-controls" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
              {!isAdmin ? (
                <button onClick={handleUnlock} style={{ background: "none", border: "1px solid rgba(255,255,255,0.1)", color: "#64748b", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
                  🔒 Login
                </button>
              ) : (
                <span style={{ fontSize: 10, background: "rgba(52,211,153,0.1)", color: "#34d399", border: "1px solid rgba(52,211,153,0.3)", padding: "4px 10px", borderRadius: 6, fontWeight: 700 }}>
                  🔓 EDITING ACTIVE
                </span>
              )}

              <span className="pulse" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#64748b" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399", display: "inline-block", boxShadow: "0 0 6px #34d399" }} />{gainers} advancing
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#64748b" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#f87171", display: "inline-block", boxShadow: "0 0 6px #f87171" }} />{losers} declining
              </span>
              <span style={{ fontSize: 11, color: "#2d3a52" }}>{allTickerCount} tickers</span>
              <button onClick={refresh} disabled={refreshing} style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, color: "#64748b", padding: "5px 12px", cursor: "pointer", fontSize: 11, fontFamily: "inherit", opacity: refreshing ? 0.5 : 1 }}>
                {refreshing ? "↻" : `↻${lastUpdated ? " · " + lastUpdated : ""}`}
              </button>
              <a
                href="https://wizzleswatchlist.substack.com/"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  fontSize: 11, fontWeight: 700, color: "#f59e0b",
                  background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)",
                  borderRadius: 8, padding: "5px 13px", textDecoration: "none",
                  letterSpacing: "0.04em", transition: "all .18s",
                  fontFamily: "'DM Mono','Fira Code',monospace",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "rgba(245,158,11,0.16)"; e.currentTarget.style.borderColor = "rgba(245,158,11,0.6)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(245,158,11,0.08)"; e.currentTarget.style.borderColor = "rgba(245,158,11,0.3)"; }}
              >
                <span style={{ fontSize: 13 }}>✉</span> Wizzle's Watchlist ↗
              </a>
            </div>
          </div>

          {/* RIGHT SIDE: Fear & Greed Gauge */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
            <FearGreedGauge />
          </div>

        </div>

        <div className="main-content" style={{ maxWidth: 1480, margin: "0 auto", padding: "32px 20px 64px", display: "flex", flexDirection: "column", gap: 28, overflowX: "hidden", boxSizing: "border-box", width: "100%" }}>
          
          {/* VIEW SWITCHER: AI hyperscaler capex flow ↔ Musk Galaxy */}
          <div style={{ display: "flex", gap: 8 }}>
            {[["ai", "🌐 AI Capex Flow"], ["musk", "🚀 Musk Galaxy"]].map(([id, label]) => (
              <button key={id} onClick={() => switchView(id)}
                style={{
                  background: view === id ? "rgba(251,191,36,0.12)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${view === id ? "#fbbf24" : "rgba(255,255,255,0.1)"}`,
                  color: view === id ? "#fbbf24" : "#64748b",
                  borderRadius: 8, padding: "8px 18px", cursor: "pointer",
                  fontSize: 12, fontWeight: 800, letterSpacing: "0.08em",
                  textTransform: "uppercase", fontFamily: "inherit", transition: "all .15s",
                }}>
                {label}
              </button>
            ))}
          </div>

          {/* HERO: capex flow Sankey — spenders → tracks, with guidance trend */}
          <CapexSankey
            key={`sankey-${view}`}
            total={liveTotal}
            live={activeIntelStatus === "success"}
            byCompany={activeIntel?.byCompany}
            tracks={activeLiveData.tracks}
            marketData={isMusk ? prices : marketData}
            history={isMusk ? [] : capexHistory}
            companyConfig={isMusk ? MUSK_COMPANIES : undefined}
            subtitle={isMusk ? "Musk Companies Capex" : undefined}
            onTrackClick={trackId => setActiveTrack(p => p === trackId ? null : trackId)}
          />

          <div className="track-grid" style={{ display: "grid", gridTemplateColumns: "repeat(6,minmax(0,1fr))", gap: 10, paddingTop: 8 }}>
            {activeLiveData.tracks.map(track => (
              <div key={track.id} style={{ paddingTop: activeTrack === track.id ? 14 : 0 }}>
                <TrackCard 
                  track={track} 
                  isActive={activeTrack === track.id} 
                  onClick={() => setActiveTrack(p => p === track.id ? null : track.id)} 
                  isAdmin={isAdmin}
                  onRenameSector={(newName) => renameSector(track.id, newName)}
                  EditableLabel={EditableLabel}
                />
              </div>
            ))}
          </div>

          {activeData && (
            <TrackPane
              track={activeData} prices={prices} isAdmin={isAdmin}
              stressBySub={subsectorStress}
              gauges={gaugesData}
              onAddTicker={addTickerToSubsector} onRemoveTicker={removeTickerFromSubsector} onTickerClick={openPopup} 
              onAddSubsector={addSubsector}
              onRemoveSubsector={removeSubsector}
              onRenameSubsector={renameSubsector}
              EditableLabel={EditableLabel}
            />
          )}

          <SupplyGraph
            key={`graph-${view}`}
            stressData={stressData}
            gaugesData={gaugesData}
            exposureData={exposureData}
            prices={prices}
            onTickerClick={openPopup}
            graphNodes={isMusk ? MUSK_GRAPH_NODES : undefined}
            graphEdges={isMusk ? MUSK_GRAPH_EDGES : undefined}
            layers={isMusk ? MUSK_LAYERS : undefined}
            title={isMusk ? "Musk Galaxy Dependency Graph" : undefined}
          />

          <BottleneckScout
            candidates={candidates}
            isAdmin={isAdmin}
            onReview={reviewCandidate}
            onTickerClick={openPopup}
          />

          <div>
            <div className="bottom-grid-all">
              
              {/* 1. Heat Map dictates the row height naturally */}
              <div className="span-2" style={{ display: "flex", flexDirection: "column" }}>
                <HeatMap prices={prices} capexData={activeLiveData} onTickerClick={openPopup} timeline={timeline} setTimeline={setTimeline} isAdmin={isAdmin} shortList={shortList} onSaveShortlist={saveGlobalShortlist} activeFilter={activeFilter} setActiveFilter={setActiveFilter} />
              </div>
              
              {/* 2. Watchlist absolute trick matches the row height and scrolls */}
              <div className="span-1 watchlist-wrapper">
                <div className="watchlist-inner">
                  <Watchlist prices={prices} capexData={activeLiveData} onTickerClick={openPopup} isAdmin={isAdmin} shortList={shortList} onSaveShortlist={saveGlobalShortlist} timeline={timeline} activeFilter={activeFilter} />
                </div>
              </div>

              {/* 3. Pre-market Gap Scanner spans the full bottom row */}
              <div className="span-3 panel-wrapper">
                <div className="panel-inner">
                  <GapScannerPanel prices={prices} onTickerClick={openPopup} />
                </div>
              </div>
            </div>
          </div>
       </div>
      </div>
      {/* TICKER TAPE */}
      <div style={{ 
        position: "fixed", 
        bottom: 0, 
        left: 0,          
        right: 0,         
        zIndex: 50, 
        height: 34, 
        overflow: "hidden", 
        borderTop: "1px solid rgba(255,255,255,.04)", 
        background: "rgba(18,18,18,0.95)", 
        padding: "6px 0" 
      }}>
        {tickerEntries.length > 0 && (
          <div className="ticker-tape">
            {[...tickerEntries, ...tickerEntries].map(([sym, val], i) => {
              const chg = val?.change ?? val;
              const sessionLabel = val?.session === "POST" || val?.session === "CLOSED" ? "AH" : val?.session === "PRE" ? "PM" : null;
              return (
                <span key={`${sym}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#64748b", fontSize: 11 }}>
                  <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{sym}</span>
                  {sessionLabel && <span style={{ fontSize: 8, fontWeight: 700, color: "#475569", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 2, padding: "0px 3px" }}>{sessionLabel}</span>}
                  {chg !== undefined && <span style={{ color: chg >= 0 ? "#34d399" : "#f87171" }}>{chg >= 0 ? "▲" : "▼"} {Math.abs(chg).toFixed(2)}%</span>}
                </span>
              )
            })}
          </div>
        )}
      </div>
      {popup && (
        <CompanyPopup
          ticker={popup.ticker}
          change={popup.change}
          anchorRect={popup.rect}
          onClose={() => setPopup(null)}
          onOpenAnalysis={(result) => setAnalysis({ ticker: popup.ticker, ...result })}
        />
      )}
      {analysis && (
        <AnalysisDrawer
          ticker={analysis.ticker}
          analysis={analysis}
          onClose={() => setAnalysis(null)}
        />
      )}
      {showAdminModal && (
        <AdminModal
          onClose={() => setShowAdminModal(false)}
          onSubmit={verifyAdminPassword}
        />
      )}
    </MobileCtx.Provider>
  );
}
