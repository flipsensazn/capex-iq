// supplyGraph.js
//
// The supply-chain dependency graph + downstream stress propagation engine.
//
// Edges run SUPPLIER → CUSTOMER (direction of goods). When a node shows
// bottleneck signals — transcript language saying it can't make enough
// (constrained_supplier) or XBRL backlog outrunning revenue — that stress
// propagates DOWNSTREAM along edges: its customers are at risk of not
// getting parts, while the bottleneck owner itself gains pricing power.
//
// The graph is hand-curated from documented supplier relationships
// (customer-concentration disclosures, partner announcements, teardowns).
// Edit freely: nodes/edges here are the model the engine runs on.
//
// criticality: 3 = sole/dominant source or critical input, 2 = major
// supplier, 1 = meaningful but substitutable.

// ── NODES ─────────────────────────────────────────────────
// layer drives the left-to-right layout: raw inputs flow toward hyperscalers.
// type "external" = non-investable chokepoint (no ticker); baseStress gives
// externals a standing stress level (e.g. China export controls) since they
// have no transcripts or filings to score them with.

export const LAYERS = [
  "Raw / External",
  "Equipment & Substrates",
  "Foundry & Memory",
  "Chips & Components",
  "Systems & Networking",
  "Datacenters, Power & Cloud",
  "Hyperscalers",
];

export const GRAPH_NODES = [
  // L0 — raw materials & external chokepoints
  { id: "CN_GALLIUM",   label: "Gallium (CN)",      layer: 0, type: "external", baseStress: 75, note: "China export controls active since 2023" },
  { id: "CN_INDIUM",    label: "Indium (CN)",       layer: 0, type: "external", baseStress: 70, note: "~70% of refined supply from China" },
  { id: "SK_HYNIX",     label: "SK Hynix (HBM)",    layer: 0, type: "external", baseStress: 65, note: "HBM capacity reportedly sold out into 2026" },
  { id: "SAMSUNG",      label: "Samsung (HBM)",     layer: 0, type: "external", baseStress: 40, note: "Second-source HBM, qualification-gated" },
  { id: "TRANSFORMERS", label: "LPT Transformers",  layer: 0, type: "external", baseStress: 80, note: "Large power transformer lead times 3-4 years" },
  { id: "GRID_QUEUES",  label: "Grid Interconnect", layer: 0, type: "external", baseStress: 75, note: "Multi-year utility interconnection queues" },

  // L1 — equipment & substrates
  { id: "ASML",  label: "ASML · EUV litho",      layer: 1 },
  { id: "AMAT",  label: "AMAT · fab equipment",  layer: 1 },
  { id: "LRCX",  label: "LRCX · etch/dep",       layer: 1 },
  { id: "KLAC",  label: "KLAC · metrology",      layer: 1 },
  { id: "VECO",  label: "VECO · MOCVD epitaxy",  layer: 1 },
  { id: "AXTI",  label: "AXTI · InP/GaAs subs",  layer: 1 },
  { id: "IQEPF", label: "IQE · epiwafers",       layer: 1 },

  // L2 — foundry & memory
  { id: "TSM",  label: "TSMC · foundry+CoWoS", layer: 2 },
  { id: "GFS",  label: "GlobalFoundries",      layer: 2 },
  { id: "TSEM", label: "Tower · SiPh foundry", layer: 2 },
  { id: "INTC", label: "Intel",                layer: 2 },
  { id: "MU",   label: "Micron · HBM/DRAM",    layer: 2 },

  // L3 — chips & components
  { id: "NVDA", label: "NVIDIA · GPUs",        layer: 3 },
  { id: "AMD",  label: "AMD · GPUs",           layer: 3 },
  { id: "AVGO", label: "Broadcom · ASIC/sw",   layer: 3 },
  { id: "MRVL", label: "Marvell · ASICs",      layer: 3 },
  { id: "ARM",  label: "Arm · CPU IP",         layer: 3 },
  { id: "LITE", label: "Lumentum · optics",    layer: 3 },
  { id: "COHR", label: "Coherent · optics",    layer: 3 },
  { id: "AAOI", label: "AOI · transceivers",   layer: 3 },
  { id: "FN",   label: "Fabrinet · opt. mfg",  layer: 3 },
  { id: "MTSI", label: "MACOM · RF/photonics", layer: 3 },
  { id: "ALAB", label: "Astera · connectivity",layer: 3 },
  { id: "APH",  label: "Amphenol · connectors",layer: 3 },
  { id: "GLW",  label: "Corning · fiber",      layer: 3 },

  // L4 — systems & networking & power gear
  { id: "SMCI", label: "Supermicro · servers", layer: 4 },
  { id: "DELL", label: "Dell · servers",       layer: 4 },
  { id: "ANET", label: "Arista · switching",   layer: 4 },
  { id: "CSCO", label: "Cisco · networking",   layer: 4 },
  { id: "VRT",  label: "Vertiv · power/cool",  layer: 4 },
  { id: "ETN",  label: "Eaton · power mgmt",   layer: 4 },
  { id: "NVT",  label: "nVent · liquid cool",  layer: 4 },
  { id: "MOD",  label: "Modine · cooling",     layer: 4 },

  // L5 — datacenters, power & cloud operators
  { id: "EQIX", label: "Equinix · DC REIT",    layer: 5 },
  { id: "DLR",  label: "Digital Realty",       layer: 5 },
  { id: "CRWV", label: "CoreWeave · GPU cloud",layer: 5 },
  { id: "NBIS", label: "Nebius · GPU cloud",   layer: 5 },
  { id: "IREN", label: "IREN · GPU cloud",     layer: 5 },
  { id: "APLD", label: "Applied Digital",      layer: 5 },
  { id: "CORZ", label: "Core Scientific",      layer: 5 },
  { id: "VST",  label: "Vistra · power",       layer: 5 },
  { id: "NEE",  label: "NextEra · power",      layer: 5 },
  { id: "LEU",  label: "Centrus · HALEU fuel", layer: 5 },
  { id: "OKLO", label: "Oklo · SMR",           layer: 5 },
  { id: "SMR",  label: "NuScale · SMR",        layer: 5 },

  // L6 — hyperscalers
  { id: "AMZN", label: "Amazon / AWS",     layer: 6 },
  { id: "MSFT", label: "Microsoft Azure",  layer: 6 },
  { id: "GOOG", label: "Google Cloud",     layer: 6 },
  { id: "META", label: "Meta",             layer: 6 },
  { id: "ORCL", label: "Oracle OCI",       layer: 6 },
];

// ── EDGES (supplier → customer) ──────────────────────────
export const GRAPH_EDGES = [
  // raw materials → substrates
  { from: "CN_GALLIUM",   to: "AXTI", what: "gallium feedstock", criticality: 3 },
  { from: "CN_INDIUM",    to: "AXTI", what: "indium feedstock",  criticality: 3 },

  // HBM → GPU vendors
  { from: "SK_HYNIX", to: "NVDA", what: "HBM3e/HBM4", criticality: 3 },
  { from: "SAMSUNG",  to: "NVDA", what: "HBM (2nd source)", criticality: 2 },
  { from: "SK_HYNIX", to: "AMD",  what: "HBM", criticality: 2 },
  { from: "MU",       to: "NVDA", what: "HBM3e", criticality: 3 },
  { from: "MU",       to: "SMCI", what: "DRAM/storage", criticality: 1 },
  { from: "MU",       to: "DELL", what: "DRAM/storage", criticality: 1 },

  // power chokepoints → utilities & DC builders
  { from: "TRANSFORMERS", to: "VST",  what: "grid transformers", criticality: 2 },
  { from: "TRANSFORMERS", to: "NEE",  what: "grid transformers", criticality: 2 },
  { from: "TRANSFORMERS", to: "EQIX", what: "substation gear", criticality: 2 },
  { from: "TRANSFORMERS", to: "DLR",  what: "substation gear", criticality: 2 },
  { from: "GRID_QUEUES",  to: "VST",  what: "interconnection", criticality: 3 },
  { from: "GRID_QUEUES",  to: "NEE",  what: "interconnection", criticality: 3 },
  { from: "GRID_QUEUES",  to: "EQIX", what: "power delivery", criticality: 2 },
  { from: "GRID_QUEUES",  to: "DLR",  what: "power delivery", criticality: 2 },
  { from: "GRID_QUEUES",  to: "APLD", what: "power delivery", criticality: 2 },

  // equipment → foundry/memory
  { from: "ASML", to: "TSM",  what: "EUV lithography", criticality: 3 },
  { from: "ASML", to: "INTC", what: "EUV lithography", criticality: 2 },
  { from: "ASML", to: "MU",   what: "EUV lithography", criticality: 2 },
  { from: "AMAT", to: "TSM",  what: "dep/etch tools", criticality: 2 },
  { from: "AMAT", to: "MU",   what: "dep/etch tools", criticality: 2 },
  { from: "AMAT", to: "INTC", what: "dep/etch tools", criticality: 2 },
  { from: "LRCX", to: "TSM",  what: "etch tools", criticality: 2 },
  { from: "LRCX", to: "MU",   what: "etch (memory-heavy)", criticality: 3 },
  { from: "KLAC", to: "TSM",  what: "process control", criticality: 2 },

  // epitaxy equipment → epi/optics makers
  { from: "VECO", to: "IQEPF", what: "MOCVD tools", criticality: 2 },
  { from: "VECO", to: "LITE",  what: "MOCVD tools", criticality: 2 },
  { from: "VECO", to: "COHR",  what: "MOCVD tools", criticality: 1 },

  // substrates/epiwafers → photonics
  { from: "AXTI",  to: "LITE", what: "InP substrates", criticality: 3 },
  { from: "AXTI",  to: "COHR", what: "InP substrates", criticality: 3 },
  { from: "AXTI",  to: "AAOI", what: "InP substrates", criticality: 2 },
  { from: "AXTI",  to: "MTSI", what: "InP/GaAs substrates", criticality: 2 },
  { from: "IQEPF", to: "LITE", what: "epiwafers", criticality: 2 },
  { from: "IQEPF", to: "COHR", what: "epiwafers", criticality: 2 },

  // foundry → chip designers
  { from: "TSM", to: "NVDA", what: "N4/N3 + CoWoS", criticality: 3 },
  { from: "TSM", to: "AMD",  what: "leading-edge nodes", criticality: 3 },
  { from: "TSM", to: "AVGO", what: "ASIC wafers", criticality: 3 },
  { from: "TSM", to: "MRVL", what: "ASIC wafers", criticality: 3 },
  { from: "TSM", to: "ALAB", what: "connectivity silicon", criticality: 2 },
  { from: "GFS",  to: "LITE", what: "silicon photonics", criticality: 1 },
  { from: "TSEM", to: "LITE", what: "SiPh foundry", criticality: 1 },
  { from: "TSEM", to: "COHR", what: "SiPh foundry", criticality: 1 },
  { from: "INTC", to: "DELL", what: "server CPUs", criticality: 1 },
  { from: "INTC", to: "SMCI", what: "server CPUs", criticality: 1 },
  { from: "ARM",  to: "NVDA", what: "CPU IP (Grace)", criticality: 2 },

  // GPUs/components → systems & clouds & hyperscalers
  { from: "NVDA", to: "SMCI", what: "GPUs", criticality: 3 },
  { from: "NVDA", to: "DELL", what: "GPUs", criticality: 3 },
  { from: "NVDA", to: "CRWV", what: "GPU allocation", criticality: 3 },
  { from: "NVDA", to: "NBIS", what: "GPU allocation", criticality: 2 },
  { from: "NVDA", to: "IREN", what: "GPU allocation", criticality: 2 },
  { from: "NVDA", to: "APLD", what: "GPU allocation", criticality: 2 },
  { from: "NVDA", to: "AMZN", what: "GPUs", criticality: 3 },
  { from: "NVDA", to: "MSFT", what: "GPUs", criticality: 3 },
  { from: "NVDA", to: "GOOG", what: "GPUs", criticality: 2 },
  { from: "NVDA", to: "META", what: "GPUs", criticality: 3 },
  { from: "NVDA", to: "ORCL", what: "GPUs", criticality: 3 },
  { from: "AMD",  to: "MSFT", what: "MI-series GPUs", criticality: 2 },
  { from: "AMD",  to: "META", what: "MI-series GPUs", criticality: 2 },
  { from: "AMD",  to: "ORCL", what: "MI-series GPUs", criticality: 1 },
  { from: "AVGO", to: "GOOG", what: "TPU co-design", criticality: 3 },
  { from: "AVGO", to: "META", what: "custom ASICs", criticality: 2 },
  { from: "AVGO", to: "ANET", what: "switch silicon", criticality: 3 },
  { from: "AVGO", to: "CSCO", what: "switch silicon", criticality: 1 },
  { from: "MRVL", to: "AMZN", what: "custom silicon", criticality: 2 },
  { from: "MRVL", to: "MSFT", what: "custom silicon", criticality: 1 },

  // optics → networking & AI systems
  { from: "LITE", to: "ANET", what: "optical transceivers", criticality: 2 },
  { from: "LITE", to: "NVDA", what: "co-pkg optics", criticality: 2 },
  { from: "COHR", to: "ANET", what: "optical transceivers", criticality: 2 },
  { from: "COHR", to: "NVDA", what: "transceivers", criticality: 2 },
  { from: "AAOI", to: "MSFT", what: "datacom optics", criticality: 1 },
  { from: "AAOI", to: "AMZN", what: "datacom optics", criticality: 1 },
  { from: "FN",   to: "NVDA", what: "800G transceiver mfg", criticality: 3 },
  { from: "FN",   to: "CSCO", what: "optics manufacturing", criticality: 1 },
  { from: "ALAB", to: "NVDA", what: "PCIe retimers", criticality: 2 },
  { from: "ALAB", to: "AMZN", what: "connectivity", criticality: 1 },
  { from: "APH",  to: "NVDA", what: "high-speed connectors", criticality: 2 },
  { from: "APH",  to: "SMCI", what: "connectors/cables", criticality: 1 },
  { from: "GLW",  to: "DLR",  what: "fiber", criticality: 1 },
  { from: "GLW",  to: "AMZN", what: "fiber", criticality: 1 },
  { from: "GLW",  to: "GOOG", what: "fiber", criticality: 1 },

  // systems → clouds & hyperscalers
  { from: "SMCI", to: "CRWV", what: "AI servers", criticality: 2 },
  { from: "SMCI", to: "META", what: "AI servers", criticality: 1 },
  { from: "DELL", to: "CRWV", what: "AI servers", criticality: 3 },
  { from: "DELL", to: "MSFT", what: "AI servers", criticality: 1 },
  { from: "ANET", to: "MSFT", what: "DC switching", criticality: 3 },
  { from: "ANET", to: "META", what: "DC switching", criticality: 3 },
  { from: "ANET", to: "ORCL", what: "DC switching", criticality: 1 },
  { from: "CSCO", to: "MSFT", what: "networking", criticality: 1 },

  // power & cooling → datacenters & hyperscalers
  { from: "VRT", to: "EQIX", what: "power/cooling systems", criticality: 2 },
  { from: "VRT", to: "DLR",  what: "power/cooling systems", criticality: 2 },
  { from: "VRT", to: "CRWV", what: "power/cooling systems", criticality: 2 },
  { from: "VRT", to: "AMZN", what: "power/cooling systems", criticality: 2 },
  { from: "VRT", to: "MSFT", what: "power/cooling systems", criticality: 2 },
  { from: "ETN", to: "EQIX", what: "switchgear/UPS", criticality: 2 },
  { from: "ETN", to: "DLR",  what: "switchgear/UPS", criticality: 2 },
  { from: "ETN", to: "MSFT", what: "switchgear/UPS", criticality: 1 },
  { from: "NVT", to: "CRWV", what: "liquid cooling", criticality: 1 },
  { from: "MOD", to: "EQIX", what: "cooling systems", criticality: 1 },
  { from: "MOD", to: "CRWV", what: "cooling systems", criticality: 1 },

  // nuclear fuel chain
  { from: "LEU", to: "OKLO", what: "HALEU fuel", criticality: 3 },
  { from: "LEU", to: "SMR",  what: "HALEU fuel", criticality: 2 },

  // power & DC capacity → hyperscalers
  { from: "VST",  to: "AMZN", what: "power PPAs", criticality: 2 },
  { from: "VST",  to: "MSFT", what: "power PPAs", criticality: 2 },
  { from: "NEE",  to: "GOOG", what: "power PPAs", criticality: 2 },
  { from: "NEE",  to: "META", what: "power PPAs", criticality: 1 },
  { from: "EQIX", to: "AMZN", what: "colo capacity", criticality: 1 },
  { from: "DLR",  to: "MSFT", what: "colo capacity", criticality: 1 },
  { from: "CRWV", to: "MSFT", what: "GPU cloud capacity", criticality: 3 },
  { from: "CORZ", to: "CRWV", what: "DC capacity", criticality: 3 },
  { from: "NBIS", to: "MSFT", what: "GPU cloud capacity", criticality: 1 },
  { from: "IREN", to: "MSFT", what: "GPU cloud capacity", criticality: 1 },
];

// ── FILED EXPOSURE (GET /exposure) ───────────────────────
// Customer-concentration disclosures: pct = % of SUPPLIER's revenue from
// that customer. Where a disclosed, NAMED customer matches an edge, the
// edge carries the filed fact and the propagation weight upgrades from
// curated criticality to a disclosure-derived weight: ≥30% of a supplier's
// revenue is treated as a fully critical relationship.

export function enrichEdges(edges, exposureData = {}) {
  if (!exposureData || !Object.keys(exposureData).length) return edges;
  return edges.map(e => {
    const match = exposureData[e.from]?.customers?.find(
      c => c.ticker === e.to && c.basis === "revenue" && c.pct != null
    );
    return match
      ? { ...e, exposurePct: match.pct, exposurePeriod: match.period, exposureForm: match.form, exposureQuote: match.quote }
      : e;
  });
}

function edgeWeight(e) {
  const curated = e.criticality / 3;
  if (e.exposurePct == null) return curated;
  return Math.max(curated, Math.min(1, e.exposurePct / 30));
}

// ── PROPAGATION ENGINE ────────────────────────────────────

const PROPAGATE_THRESHOLD = 40; // a node must be this stressed to radiate
const HOP_DECAY = 0.65;         // stress retained per hop (× edge weight)
const MIN_RISK = 8;             // stop propagating below this

// Intrinsic bottleneck strength per node, 0-100.
// Transcript: only counts when the company ITSELF is the constrained one
// (constrained_supplier / both) — a constrained BUYER is a symptom, not a
// source. XBRL backlog score counts at a small discount (numbers lag words).
// External chokepoints carry their curated baseStress.
export function computeStrength(nodes, stressData = {}, gaugesData = {}) {
  const strength = {};
  for (const node of nodes) {
    let s = node.baseStress ?? 0;
    const t = stressData[node.id]?.latest;
    if (t?.stressScore != null && (t.direction === "constrained_supplier" || t.direction === "both")) {
      s = Math.max(s, t.stressScore);
    }
    const g = gaugesData[node.id];
    if (g?.backlogScore != null) {
      s = Math.max(s, g.backlogScore * 0.85);
    }
    strength[node.id] = s;
  }
  return strength;
}

// BFS downstream from every node radiating ≥ PROPAGATE_THRESHOLD.
// Returns { nodeId: { score, contributors: [{source, what, hops, score}] } }
// where `source` is the ROOT bottleneck and `what` is the input that carries
// the risk into this node — i.e. "LITE is at risk via AXTI's InP substrates".
export function propagate(nodes, edges, strength) {
  const edgesFrom = {};
  for (const e of edges) (edgesFrom[e.from] ??= []).push(e);

  const risk = {};
  for (const root of nodes) {
    const s0 = strength[root.id] ?? 0;
    if (s0 < PROPAGATE_THRESHOLD) continue;

    const bestFromRoot = { [root.id]: s0 };
    const queue = [[root.id, s0, 0]];
    while (queue.length) {
      const [cur, s, hops] = queue.shift();
      for (const e of edgesFrom[cur] ?? []) {
        const ns = s * HOP_DECAY * edgeWeight(e);
        if (ns < MIN_RISK) continue;
        if (ns <= (bestFromRoot[e.to] ?? 0)) continue;
        bestFromRoot[e.to] = ns;
        const entry = (risk[e.to] ??= { score: 0, contributors: [] });
        const existing = entry.contributors.find(c => c.source === root.id);
        if (existing) {
          if (ns > existing.score) Object.assign(existing, { score: ns, what: e.what, hops: hops + 1 });
        } else {
          entry.contributors.push({ source: root.id, what: e.what, hops: hops + 1, score: ns });
        }
        queue.push([e.to, ns, hops + 1]);
      }
    }
  }

  for (const entry of Object.values(risk)) {
    entry.contributors.sort((a, b) => b.score - a.score);
    // Soft-OR: independent risks stack but never exceed 100
    entry.score = Math.round(100 * (1 - entry.contributors.reduce((p, c) => p * (1 - c.score / 100), 1)));
  }
  return risk;
}

// Direct neighbors for the detail panel.
export function neighbors(edges, nodeId) {
  return {
    suppliers: edges.filter(e => e.to === nodeId),
    customers: edges.filter(e => e.from === nodeId),
  };
}

// All nodes reachable downstream/upstream of nodeId (for highlight).
export function reachable(edges, nodeId, direction = "down") {
  const adj = {};
  for (const e of edges) {
    const [a, b] = direction === "down" ? [e.from, e.to] : [e.to, e.from];
    (adj[a] ??= []).push(b);
  }
  const seen = new Set();
  const queue = [nodeId];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of adj[cur] ?? []) {
      if (!seen.has(nxt)) { seen.add(nxt); queue.push(nxt); }
    }
  }
  return seen;
}
