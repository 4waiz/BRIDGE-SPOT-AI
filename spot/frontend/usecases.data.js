/*
 * BRIDGE SPOT — Industry 5.0 demo use cases (DEMO DATA ONLY).
 *
 * This file is the single source of truth for the use-case cards on the
 * launcher and the content shown in each demo detail modal. It is intentionally
 * plain mock JSON so it can later be swapped for live data from the Spot SDK /
 * BRIDGE backend.
 *
 * ------------------------------------------------------------------------
 * FUTURE REAL API INTEGRATION
 * ------------------------------------------------------------------------
 * When wiring real data:
 *   - Replace `USE_CASES` below with a fetch from the backend, e.g.
 *       const USE_CASES = await fetch('/api/usecases').then(r => r.json());
 *   - Each `mockStatus` array maps 1:1 to live status/telemetry cards. Replace
 *     the static values with values returned by the Spot API / asset DB.
 *   - Each `actions[].id` is the hook for a real call. Wire them in
 *     usecases.js -> handleMockAction() (see the TODO markers there).
 * Nothing here talks to a robot. All values are illustrative.
 */

// Shared accent so JS-built badges/markup can reference the brand colour.
const BRIDGE_ACCENT = "#ff5622";

const USE_CASES = [
  {
    id: "inspection-copilot",
    title: "AI Facility Inspection Copilot",
    // One-line description shown in the detail view.
    tagline: "Autonomous visual and thermal inspection with AI-generated findings.",
    // Short blurb used on the compact mission-module cards.
    short: "Run AI-guided visual and thermal inspection routes.",
    // `icon` is a key into the shared icon set in bridge-shell.js.
    icon: "scan",
    overview:
      "Spot patrols selected facility areas using Spot CAM+IR and captures visual and thermal data. The software analyzes the findings and generates an inspection report.",
    spotDoes: [
      "Runs the selected inspection route",
      "Captures RGB, zoom, and thermal snapshots",
      "Identifies open panels, blocked paths, heat anomalies, and unsafe areas",
    ],
    appDoes: [
      "Live inspection dashboard",
      "AI findings list",
      "Severity scoring",
      "Report generation",
    ],
    benefits: [
      "Reduces manual inspection effort",
      "Improves operational visibility",
      "Demonstrates AI + robotics for Industry 5.0",
    ],
    // Mock action buttons. `id` is the future API hook.
    actions: [
      { id: "start-patrol", label: "Start Demo Patrol", primary: true },
      { id: "generate-report", label: "Generate Report" },
      { id: "view-findings", label: "View Findings" },
    ],
    // Mock status / data cards rendered in the detail view.
    mockStatus: [
      { label: "Route progress", value: "6 / 8 waypoints", tone: "info" },
      { label: "Findings", value: "3 open", tone: "warn" },
      { label: "Thermal anomalies", value: "1 detected", tone: "warn" },
      { label: "Last patrol", value: "Today, 09:42", tone: "ok" },
    ],
  },
  {
    id: "predictive-maintenance",
    title: "Predictive Maintenance Command Center",
    tagline: "Track asset health, detect anomalies, and flag early maintenance risks.",
    short: "Monitor, predict, and prevent equipment issues.",
    icon: "chartUp",
    overview:
      "Spot repeatedly inspects assets and compares their current condition with historical baselines to surface early signs of failure.",
    spotDoes: [
      "Checks panels, HVAC, batteries, machines, and server areas",
      "Captures visual and thermal readings",
      "Repeats the same inspection route over time",
    ],
    appDoes: [
      "Asset health dashboard",
      "Thermal trend charts",
      "Anomaly score",
      "Maintenance priority",
    ],
    benefits: [
      "Detects issues before failure",
      "Supports maintenance planning",
      "Converts robot data into business intelligence",
    ],
    actions: [
      { id: "run-asset-scan", label: "Run Asset Scan", primary: true },
      { id: "view-asset-health", label: "View Asset Health" },
      { id: "export-maintenance", label: "Export Maintenance Summary" },
    ],
    mockStatus: [
      { label: "Assets tracked", value: "24", tone: "info" },
      { label: "Healthy", value: "21", tone: "ok" },
      { label: "Watch list", value: "2", tone: "warn" },
      { label: "Critical", value: "1", tone: "bad" },
    ],
  },
  {
    id: "safety-response",
    title: "Human-Robot Safety & Emergency Response",
    tagline: "Run safety scenarios with live robot inspection and response scoring.",
    short: "Enhance site safety and emergency readiness.",
    icon: "shield",
    overview:
      "Spot supports safety drills and emergency-response training by inspecting simulated incident zones while the team practices their response.",
    spotDoes: [
      "Moves to the incident location",
      "Streams visual and thermal feed",
      "Captures evidence safely",
    ],
    appDoes: [
      "Scenario selector",
      "Live incident dashboard",
      "Decision logging",
      "Response scoring",
    ],
    benefits: [
      "Improves safety training",
      "Supports resilience and scenario planning",
      "Shows human-robot collaboration",
    ],
    actions: [
      { id: "launch-scenario", label: "Launch Scenario", primary: true },
      { id: "dispatch-spot", label: "Dispatch Spot" },
      { id: "incident-report", label: "Generate Incident Report" },
    ],
    mockStatus: [
      { label: "Scenario", value: "Server room fire", tone: "info" },
      { label: "Spot status", value: "En route", tone: "warn" },
      { label: "Response score", value: "82 / 100", tone: "ok" },
      { label: "Decisions logged", value: "5", tone: "info" },
    ],
  },
  {
    id: "readiness-evaluator",
    title: "Agile / Readiness Assessment Evaluator",
    tagline: "Use Spot as a mobile evaluator for training stations and team readiness.",
    short: "Evaluate operational readiness and mission agility.",
    icon: "target",
    overview:
      "Spot acts as a mobile evaluator during BRIDGE training exercises, visiting stations and capturing evidence of completion.",
    spotDoes: [
      "Moves between assessment stations",
      "Reads visual markers / QR codes",
      "Captures completion evidence",
    ],
    appDoes: [
      "Readiness score dashboard",
      "Team performance view",
      "Collaboration and response metrics",
    ],
    benefits: [
      "Makes training interactive",
      "Supports agile and business readiness workshops",
      "Turns assessment into measurable output",
    ],
    actions: [
      { id: "start-assessment", label: "Start Assessment", primary: true },
      { id: "view-team-scores", label: "View Team Scores" },
      { id: "export-readiness", label: "Export Readiness Report" },
    ],
    mockStatus: [
      { label: "Stations visited", value: "4 / 6", tone: "info" },
      { label: "Team readiness", value: "76%", tone: "ok" },
      { label: "Collaboration", value: "High", tone: "ok" },
      { label: "Flagged gaps", value: "2", tone: "warn" },
    ],
  },
  {
    id: "digital-twin-mission",
    title: "Digital Twin + Natural Language Mission Builder",
    tagline: "Convert plain-language instructions into robot missions and digital twin updates.",
    short: "Create missions with natural language.",
    icon: "cube",
    overview:
      "Users type natural-language instructions and the app converts them into robot mission tasks, then updates the digital twin as Spot completes them.",
    spotDoes: [
      "Executes the selected route or task",
      "Captures inspection data",
      "Updates asset / room history",
    ],
    appDoes: [
      "Natural-language mission input",
      "Digital twin map / dashboard",
      "Mission progress tracker",
      "Inspection history",
    ],
    benefits: [
      "Makes Spot easier for non-technical users",
      "Demonstrates agentic AI + robotics",
      "Supports digital transformation demos",
    ],
    actions: [
      { id: "build-mission", label: "Build Mission", primary: true },
      { id: "run-mission", label: "Run Mission" },
      { id: "update-twin", label: "Update Digital Twin" },
    ],
    // Optional NL prompt sample shown in this card's detail view.
    samplePrompt: "Inspect the east server room and the loading dock, then log any open panels.",
    mockStatus: [
      { label: "Mission steps", value: "3 parsed", tone: "info" },
      { label: "Twin coverage", value: "92%", tone: "ok" },
      { label: "Progress", value: "Step 2 of 3", tone: "warn" },
      { label: "Rooms updated", value: "5", tone: "ok" },
    ],
  },
];

/*
 * Spot Admin — kept as the admin/settings entry. Demo-only status block.
 *
 * FUTURE: replace these static values with live robot state from the Spot SDK
 * (robot.get_robot_state) and the BRIDGE config service.
 */
const ADMIN_INFO = {
  id: "spot-admin",
  title: "Spot Admin",
  tagline: "Robot connection, system settings, and API configuration.",
  short: "Manage users, connection and permissions.",
  icon: "userGear",
  // The real admin console already lives behind this link; the modal is a
  // demo-friendly status preview that does not require a live robot.
  externalUrl: "https://192.168.208.117",
  status: [
    { label: "Robot connection", value: "Demo / Not Connected", tone: "warn" },
    { label: "API mode", value: "Mock", tone: "info" },
    { label: "Payloads", value: "Spot CAM+IR, Jetson / Core I/O-ready", tone: "ok" },
    { label: "Network", value: "Demo Network", tone: "info" },
  ],
  actions: [
    { id: "test-connection", label: "Test Connection", primary: true },
    { id: "view-logs", label: "View Logs" },
    { id: "configure-api", label: "Configure API" },
    { id: "open-admin", label: "Open Admin Console", external: true },
  ],
};

// Expose to the launcher script (kept as plain globals — no build step here).
window.BRIDGE_SPOT_DEMO = { USE_CASES, ADMIN_INFO, BRIDGE_ACCENT };
