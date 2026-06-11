// muskData.js
//
// The Musk Galaxy view: capex flow + supply-chain dependency for Elon Musk's
// companies (Tesla, SpaceX/Starlink, xAI, Terafab, Boring, Neuralink).
// Mirrors the AI-hyperscaler structures: a capex map (tracks → subsectors →
// supplier tickers) and a dependency graph for the propagation engine.
// Only TSLA is publicly traded — the other Musk companies appear as private
// demand hubs (no price, no stress feed; risk propagates INTO them from
// their public suppliers).
//
// Supplier edges are curated from documented relationships: Supermicro/Dell
// build xAI's Colossus clusters, Vertiv cools them, CAT (Solar Turbines) and
// GE Vernova power them; ON/ST supply Tesla SiC, Panasonic supplies cells,
// Piedmont holds a Tesla lithium offtake; ST makes Starlink user-terminal
// silicon and Filtronic the E-band amplifiers; fab equipment majors feed the
// planned Terafab project. Edit freely — this file is the model.

export const MUSK_CAPEX_DATA = {
  version: 1,
  companies: ["TSLA", "SPACEX", "XAI", "STARLINK", "BORING", "NEURALINK"],
  tracks: [
    {
      id: "ai", label: "AI & Compute (xAI · Dojo · Terafab)", value: "~$25B", capex: 25,
      color: "#60a5fa", borderColor: "#3b82f6",
      subsectors: [
        { id: "gpus", label: "GPUs & Accelerators", tickers: ["NVDA"], materials: ["HBM", "CoWoS Packaging", "Silicon Wafer 300mm"] },
        { id: "fab", label: "Foundry & Fab Equipment (Terafab)", tickers: ["TSM", "AMAT", "LRCX", "KLAC", "ASML"], materials: ["EUV Lithography", "Cleanroom Capacity", "Ultrapure Water"] },
        { id: "servers", label: "AI Servers & Cooling (Colossus)", tickers: ["SMCI", "DELL", "VRT"], materials: ["Liquid Cooling Loops", "High-density Racks", "Busbars"] },
        { id: "memory", label: "Memory", tickers: ["MU"], materials: ["HBM3e Stacks", "LPDDR5"] },
      ],
    },
    {
      id: "vehicles", label: "Vehicles & Autonomy (Tesla)", value: "~$12B", capex: 12,
      color: "#34d399", borderColor: "#10b981",
      subsectors: [
        { id: "powersemi", label: "Power Semiconductors (SiC)", tickers: ["ON", "STM", "WOLF"], materials: ["SiC Boules", "200mm SiC Wafers"] },
        { id: "battery", label: "Battery Cells & Materials", tickers: ["PCRFY", "ALB", "SQM", "PLL"], materials: [ { name: "Lithium", constraint: "Refining concentrated in China", color: "#f59e0b" }, { name: "Graphite Anode", constraint: "China export controls active", color: "#ef4444" }, "Nickel", "Separator Film" ] },
        { id: "components", label: "Vehicle Components", tickers: ["APTV"], materials: ["Wiring Harnesses", "Castings", "Aluminum"] },
        { id: "autonomy", label: "Autonomy Compute", tickers: ["NVDA", "TSM"], materials: ["FSD/Dojo Silicon", "Training Clusters"] },
      ],
    },
    {
      id: "space", label: "Launch & Starlink (SpaceX)", value: "~$15B", capex: 15,
      color: "#fbbf24", borderColor: "#f59e0b",
      subsectors: [
        { id: "alloys", label: "Structures & Specialty Alloys", tickers: ["ATI", "CRS", "HWM"], materials: ["Stainless Alloys", "Titanium", "Superalloy Fasteners"] },
        { id: "rf", label: "RF & Terminal Silicon", tickers: ["STM", "FLTCF", "QRVO"], materials: ["E-band Amplifiers", "Phased-Array ASICs", "GaAs/GaN RF"] },
        { id: "sat", label: "Satellite Components", tickers: ["RDW"], materials: ["Solar Arrays", "Radiation-Hardened Parts", "Optical Links"] },
      ],
    },
    {
      id: "energy", label: "Energy & Storage", value: "~$5B", capex: 5,
      color: "#c084fc", borderColor: "#a855f7",
      subsectors: [
        { id: "storage", label: "Cells & Storage Systems (Megapack)", tickers: ["PCRFY", "ENS"], materials: ["LFP Cells", "Inverters", "Thermal Management"] },
        { id: "gridinfra", label: "Grid & Charging Infrastructure", tickers: ["HUBB"], materials: ["Switchgear", "Charging Hardware", "Copper"] },
      ],
    },
    {
      id: "infra", label: "Build-out, Power & Tunnels", value: "~$8B", capex: 8,
      color: "#fb923c", borderColor: "#f97316",
      subsectors: [
        { id: "sitepower", label: "Site Power & Turbines", tickers: ["CAT", "GEV", "ETN"], materials: [ { name: "Gas Turbines", constraint: "Multi-year order books", color: "#f59e0b" }, "Switchgear", "Transformers" ] },
        { id: "construction", label: "Construction & Machinery", tickers: ["URI"], materials: ["TBM Components", "Concrete", "Heavy Equipment"] },
      ],
    },
    {
      id: "frontier", label: "Neuralink & Robotics", value: "Early", capex: 3,
      color: "#f472b6", borderColor: "#ec4899",
      subsectors: [
        { id: "robotics", label: "Robotics & Actuators (Optimus)", tickers: ["TER", "CTS"], materials: ["Servo Actuators", "Harmonic Drives", "Sensors"] },
        { id: "neural", label: "Neural Interfaces", tickers: [], materials: ["Implant-grade Polymers", "Microfabrication"] },
      ],
    },
  ],
};

// Sankey left-side config. share = fallback split of total capex until the
// grounded musk-intel byCompany arrives. Only TSLA has market data.
export const MUSK_COMPANIES = [
  { id: "TSLA",      label: "Tesla",     share: 0.28, isPublic: true },
  { id: "XAI",       label: "xAI",       share: 0.30, isPublic: false },
  { id: "SPACEX",    label: "SpaceX",    share: 0.24, isPublic: false },
  { id: "STARLINK",  label: "Starlink",  share: 0.12, isPublic: false },
  { id: "BORING",    label: "Boring Co", share: 0.03, isPublic: false },
  { id: "NEURALINK", label: "Neuralink", share: 0.03, isPublic: false },
];

// ── DEPENDENCY GRAPH ─────────────────────────────────────

export const MUSK_LAYERS = [
  "Raw / External",
  "Materials & Equipment",
  "Chips & Components",
  "Systems & Integration",
  "Musk Companies",
];

export const MUSK_GRAPH_NODES = [
  // L0 — external chokepoints
  { id: "CN_LITHIUM",   label: "Li Refining (CN)",  layer: 0, type: "external", baseStress: 65, note: "Majority of lithium refining capacity in China" },
  { id: "CN_GRAPHITE",  label: "Graphite (CN)",     layer: 0, type: "external", baseStress: 70, note: "Anode graphite under China export controls" },
  { id: "SK_HYNIX",     label: "SK Hynix (HBM)",    layer: 0, type: "external", baseStress: 65, note: "HBM capacity reportedly sold out into 2026" },
  { id: "TRANSFORMERS", label: "LPT Transformers",  layer: 0, type: "external", baseStress: 80, note: "Large power transformer lead times 3-4 years" },
  { id: "GRID_QUEUES",  label: "Grid Interconnect", layer: 0, type: "external", baseStress: 75, note: "Multi-year utility interconnection queues" },

  // L1 — materials & equipment
  { id: "ALB",  label: "Albemarle · lithium",   layer: 1 },
  { id: "SQM",  label: "SQM · lithium",         layer: 1 },
  { id: "PLL",  label: "Piedmont · Li offtake", layer: 1 },
  { id: "ATI",  label: "ATI · specialty alloys",layer: 1 },
  { id: "CRS",  label: "Carpenter · alloys",    layer: 1 },
  { id: "AMAT", label: "AMAT · fab equipment",  layer: 1 },
  { id: "LRCX", label: "LRCX · etch/dep",       layer: 1 },
  { id: "KLAC", label: "KLAC · metrology",      layer: 1 },
  { id: "ASML", label: "ASML · EUV litho",      layer: 1 },

  // L2 — chips & components
  { id: "TSM",   label: "TSMC · foundry",        layer: 2 },
  { id: "NVDA",  label: "NVIDIA · GPUs",         layer: 2 },
  { id: "ON",    label: "onsemi · SiC",          layer: 2 },
  { id: "STM",   label: "ST · SiC + Starlink",   layer: 2 },
  { id: "WOLF",  label: "Wolfspeed · SiC",       layer: 2 },
  { id: "MU",    label: "Micron · memory",       layer: 2 },
  { id: "QRVO",  label: "Qorvo · RF",            layer: 2 },
  { id: "FLTCF", label: "Filtronic · E-band",    layer: 2 },

  // L3 — systems & integration
  { id: "SMCI",  label: "Supermicro · servers",  layer: 3 },
  { id: "DELL",  label: "Dell · servers",        layer: 3 },
  { id: "VRT",   label: "Vertiv · cooling",      layer: 3 },
  { id: "PCRFY", label: "Panasonic · cells",     layer: 3 },
  { id: "APTV",  label: "Aptiv · harnesses",     layer: 3 },
  { id: "HWM",   label: "Howmet · aero parts",   layer: 3 },
  { id: "RDW",   label: "Redwire · sat parts",   layer: 3 },
  { id: "CAT",   label: "CAT · turbines/machines", layer: 3 },
  { id: "GEV",   label: "GE Vernova · turbines", layer: 3 },
  { id: "ETN",   label: "Eaton · electrical",    layer: 3 },

  // L4 — the galaxy (only TSLA is tradeable)
  { id: "TSLA",      label: "Tesla",            layer: 4 },
  { id: "XAI",       label: "xAI · Colossus",   layer: 4, type: "external", note: "Private — ~$250B valuation" },
  { id: "SPACEX",    label: "SpaceX",           layer: 4, type: "external", note: "Private — ~$1.8T valuation, Musk 82.4%" },
  { id: "STARLINK",  label: "Starlink",         layer: 4, type: "external", note: "SpaceX subsidiary — ~$500B" },
  { id: "TERAFAB",   label: "Terafab (JV)",     layer: 4, type: "external", note: "Planned chip fab — ~$55B project investment" },
  { id: "BORING",    label: "Boring Co",        layer: 4, type: "external", note: "Private — ~$6B valuation" },
  { id: "NEURALINK", label: "Neuralink",        layer: 4, type: "external", note: "Private — ~$10B valuation" },
];

export const MUSK_GRAPH_EDGES = [
  // raw → materials
  { from: "CN_LITHIUM",  to: "ALB",   what: "refining capacity", criticality: 2 },
  { from: "CN_LITHIUM",  to: "SQM",   what: "refining capacity", criticality: 2 },
  { from: "CN_GRAPHITE", to: "PCRFY", what: "anode graphite", criticality: 3 },
  { from: "SK_HYNIX",    to: "NVDA",  what: "HBM", criticality: 3 },
  { from: "TRANSFORMERS", to: "TSLA", what: "gigafactory power", criticality: 2 },
  { from: "TRANSFORMERS", to: "XAI",  what: "datacenter power", criticality: 2 },
  { from: "GRID_QUEUES",  to: "XAI",  what: "interconnection", criticality: 3 },
  { from: "GRID_QUEUES",  to: "TSLA", what: "interconnection", criticality: 2 },

  // materials → Musk cos / cells
  { from: "ALB", to: "TSLA",  what: "lithium hydroxide", criticality: 2 },
  { from: "ALB", to: "PCRFY", what: "lithium", criticality: 2 },
  { from: "SQM", to: "TSLA",  what: "lithium", criticality: 1 },
  { from: "PLL", to: "TSLA",  what: "Li offtake agreement", criticality: 2 },
  { from: "ATI", to: "SPACEX", what: "specialty alloys", criticality: 1 },
  { from: "CRS", to: "SPACEX", what: "superalloys", criticality: 1 },

  // fab equipment → Terafab
  { from: "AMAT", to: "TERAFAB", what: "dep/etch tools", criticality: 2 },
  { from: "LRCX", to: "TERAFAB", what: "etch tools", criticality: 2 },
  { from: "KLAC", to: "TERAFAB", what: "process control", criticality: 2 },
  { from: "ASML", to: "TERAFAB", what: "lithography", criticality: 3 },

  // chips
  { from: "TSM",  to: "NVDA", what: "leading-edge + CoWoS", criticality: 3 },
  { from: "TSM",  to: "TSLA", what: "FSD/Dojo silicon", criticality: 2 },
  { from: "NVDA", to: "XAI",  what: "GPU allocation (Colossus)", criticality: 3 },
  { from: "NVDA", to: "TSLA", what: "training clusters", criticality: 2 },
  { from: "ON",   to: "TSLA", what: "SiC inverter modules", criticality: 3 },
  { from: "STM",  to: "TSLA", what: "SiC modules", criticality: 2 },
  { from: "STM",  to: "STARLINK", what: "user-terminal SoC", criticality: 3 },
  { from: "WOLF", to: "TSLA", what: "SiC substrates", criticality: 1 },
  { from: "MU",   to: "XAI",  what: "memory", criticality: 1 },
  { from: "QRVO", to: "STARLINK", what: "RF front-ends", criticality: 1 },
  { from: "FLTCF", to: "SPACEX", what: "E-band amplifiers", criticality: 3 },

  // systems → Musk cos
  { from: "SMCI",  to: "XAI", what: "Colossus servers", criticality: 3 },
  { from: "DELL",  to: "XAI", what: "Colossus servers", criticality: 3 },
  { from: "VRT",   to: "XAI", what: "liquid cooling", criticality: 2 },
  { from: "PCRFY", to: "TSLA", what: "battery cells", criticality: 3 },
  { from: "APTV",  to: "TSLA", what: "wiring harnesses", criticality: 2 },
  { from: "HWM",   to: "SPACEX", what: "aero fasteners/castings", criticality: 1 },
  { from: "RDW",   to: "STARLINK", what: "satellite components", criticality: 1 },
  { from: "CAT",   to: "XAI", what: "gas turbines (site power)", criticality: 2 },
  { from: "CAT",   to: "BORING", what: "heavy machinery", criticality: 2 },
  { from: "GEV",   to: "XAI", what: "turbines (Colossus 2)", criticality: 2 },
  { from: "ETN",   to: "XAI", what: "switchgear", criticality: 1 },

  // intra-galaxy
  { from: "TERAFAB", to: "XAI",  what: "future chip supply", criticality: 2 },
  { from: "TERAFAB", to: "TSLA", what: "future chip supply", criticality: 2 },
  { from: "SPACEX",  to: "STARLINK", what: "launch capacity", criticality: 3 },
];

export function getMuskTickers(data = MUSK_CAPEX_DATA) {
  return [...new Set(data.tracks.flatMap(t => t.subsectors.flatMap(s => s.tickers)))];
}
