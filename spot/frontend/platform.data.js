/*
 * BRIDGE SPOT - platform demo dataset (DEMO DATA ONLY).
 *
 * Shared by dashboard.html, missions.html, reports.html and assets.html so the
 * numbers stay consistent across the platform. Nothing here talks to a robot.
 *
 * ----------------------------------------------------------------------
 * FUTURE REAL API INTEGRATION
 * ----------------------------------------------------------------------
 *   MISSIONS  -> GET /api/missions        (mission scheduler / Spot Autowalk)
 *   ASSETS    -> GET /api/assets          (asset DB + thermal history)
 *   REPORTS   -> GET /api/reports         (report service)
 *   ACTIVITY  -> GET /api/activity?days=7 (inspection counters)
 *   FINDINGS  -> GET /api/findings        (vision model output)
 * Each record below matches the shape those endpoints should return.
 */
(function (window) {
    "use strict";

    var MISSIONS = [
        {
            id: "m-1041",
            name: "Digital Factory, morning sweep",
            route: "DigitalFactory",
            module: "inspection-copilot",
            status: "running",
            progress: 62,
            waypoints: 8,
            done: 5,
            operator: "Spot Admin",
            started: "Today, 09:42",
            duration: "18 min",
            findings: 3,
            page: "digital_factory.html"
        },
        {
            id: "m-1040",
            name: "HSSE walkway & PPE patrol",
            route: "HSSE",
            module: "safety-response",
            status: "scheduled",
            progress: 0,
            waypoints: 6,
            done: 0,
            operator: "Automation",
            started: "Today, 14:00",
            duration: "12 min",
            findings: 0,
            page: "hsse.html"
        },
        {
            id: "m-1039",
            name: "Switchgear thermal baseline",
            route: "DigitalFactory",
            module: "predictive-maintenance",
            status: "completed",
            progress: 100,
            waypoints: 5,
            done: 5,
            operator: "Spot Admin",
            started: "Today, 07:15",
            duration: "22 min",
            findings: 2,
            page: "assets.html"
        },
        {
            id: "m-1038",
            name: "Readiness stations, Team Delta",
            route: "Training bay",
            module: "readiness-evaluator",
            status: "completed",
            progress: 100,
            waypoints: 6,
            done: 6,
            operator: "L. Ortega",
            started: "Yesterday, 16:20",
            duration: "31 min",
            findings: 2,
            page: "reports.html"
        },
        {
            id: "m-1037",
            name: "Server room night patrol",
            route: "HSSE",
            module: "inspection-copilot",
            status: "failed",
            progress: 41,
            waypoints: 7,
            done: 3,
            operator: "Automation",
            started: "Yesterday, 23:05",
            duration: "9 min",
            findings: 1,
            page: "hsse.html"
        }
    ];

    var ASSETS = [
        { id: "PMP-102", name: "Coolant pump P-102", area: "Bay 2", type: "Pump", health: 42, temp: "68 °C", trend: [51, 55, 58, 61, 64, 66, 68], lastSeen: "Today, 09:51", status: "critical", note: "Bearing temperature rising for 6 consecutive inspections." },
        { id: "SWG-004", name: "Switchgear panel SG-04", area: "Utility room", type: "Electrical", health: 61, temp: "47 °C", trend: [38, 39, 41, 43, 44, 46, 47], lastSeen: "Today, 07:32", status: "watch", note: "Hot spot on phase B busbar; schedule thermographic check." },
        { id: "HVC-011", name: "HVAC unit AHU-11", area: "Roof", type: "HVAC", health: 68, temp: "39 °C", trend: [35, 36, 36, 37, 38, 38, 39], lastSeen: "Today, 08:10", status: "watch", note: "Filter differential pressure trending up." },
        { id: "CNV-220", name: "Conveyor drive CV-220", area: "Bay 4", type: "Drive", health: 88, temp: "34 °C", trend: [33, 34, 33, 34, 34, 33, 34], lastSeen: "Today, 09:46", status: "healthy", note: "Stable since last service." },
        { id: "RBT-007", name: "Robot cell R-07", area: "Bay 4", type: "Robotics", health: 92, temp: "31 °C", trend: [30, 31, 31, 30, 31, 31, 31], lastSeen: "Today, 09:48", status: "healthy", note: "No anomalies detected." },
        { id: "GEN-001", name: "Backup generator G-01", area: "Yard", type: "Generator", health: 79, temp: "36 °C", trend: [34, 35, 35, 36, 35, 36, 36], lastSeen: "Yesterday, 18:02", status: "healthy", note: "Weekly test run completed successfully." },
        { id: "SRV-A12", name: "Server rack A-12", area: "Server room", type: "IT", health: 74, temp: "41 °C", trend: [37, 38, 39, 39, 40, 41, 41], lastSeen: "Today, 03:12", status: "watch", note: "Inlet temperature above target during night hours." },
        { id: "DOR-003", name: "Fire door FD-03", area: "Bay 3", type: "Safety", health: 55, temp: "-", trend: [70, 68, 66, 62, 60, 57, 55], lastSeen: "Today, 09:20", status: "watch", note: "Detected obstructed twice this week." }
    ];

    var REPORTS = [
        { id: "RPT-2041", title: "Digital Factory inspection summary", type: "Inspection", module: "inspection-copilot", created: "Today, 10:04", author: "Spot Admin", findings: 3, status: "ready" },
        { id: "RPT-2040", title: "Weekly asset health digest", type: "Maintenance", module: "predictive-maintenance", created: "Today, 08:05", author: "Automation", findings: 4, status: "ready" },
        { id: "RPT-2039", title: "HSSE patrol, walkway obstructions", type: "Safety", module: "safety-response", created: "Yesterday, 17:40", author: "Automation", findings: 2, status: "ready" },
        { id: "RPT-2038", title: "Team Delta readiness assessment", type: "Readiness", module: "readiness-evaluator", created: "Yesterday, 16:58", author: "L. Ortega", findings: 2, status: "ready" },
        { id: "RPT-2037", title: "Night patrol incident log", type: "Safety", module: "safety-response", created: "2 days ago", author: "Automation", findings: 1, status: "archived" }
    ];

    // Inspections per weekday (last 7 days), drives the dashboard bar chart.
    var ACTIVITY = [
        { label: "Mon", missions: 6, findings: 2 },
        { label: "Tue", missions: 8, findings: 3 },
        { label: "Wed", missions: 5, findings: 1 },
        { label: "Thu", missions: 9, findings: 4 },
        { label: "Fri", missions: 7, findings: 2 },
        { label: "Sat", missions: 3, findings: 0 },
        { label: "Sun", missions: 4, findings: 1 }
    ];

    var FINDINGS = [
        { id: "F-318", severity: "critical", title: "Coolant pump P-102 running 12 °C above baseline", asset: "PMP-102", route: "DigitalFactory", time: "Today, 09:51" },
        { id: "F-317", severity: "warning", title: "Open electrical panel in Utility room", asset: "SWG-004", route: "DigitalFactory", time: "Today, 09:47" },
        { id: "F-316", severity: "warning", title: "Walkway obstructed by pallet in Bay 3", asset: "DOR-003", route: "HSSE", time: "Today, 09:20" },
        { id: "F-315", severity: "info", title: "Server room inlet temperature above target", asset: "SRV-A12", route: "HSSE", time: "Today, 03:12" },
        { id: "F-314", severity: "warning", title: "Missing PPE detected near loading dock", asset: "-", route: "HSSE", time: "Yesterday, 17:32" }
    ];

    var KPIS = [
        { key: "missions", label: "Missions today", value: "7", delta: "+2 vs. yesterday", tone: "up", icon: "mission" },
        { key: "findings", label: "Open findings", value: "5", delta: "2 need attention", tone: "down", icon: "alert" },
        { key: "assets", label: "Assets healthy", value: "21 / 24", delta: "88% of fleet", tone: "up", icon: "assets" },
        { key: "uptime", label: "Robot uptime", value: "96.4%", delta: "Last 30 days", tone: "flat", icon: "gauge" }
    ];

    window.BRIDGE_PLATFORM = {
        MISSIONS: MISSIONS,
        ASSETS: ASSETS,
        REPORTS: REPORTS,
        ACTIVITY: ACTIVITY,
        FINDINGS: FINDINGS,
        KPIS: KPIS
    };
})(window);
