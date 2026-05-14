import React, { useState, useEffect, useCallback, useMemo } from "react";

const DB_NAME = "AmazonJobRadarDB_v2";
const STORE_NAME = "job_registry";

const initDB = () => {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") return resolve(null);
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const persistJobToDB = async (job) => {
  const db = await initDB();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(job);
    tx.oncomplete = () => resolve(true);
  });
};

const fetchSavedJobsFromDB = async () => {
  const db = await initDB();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
  });
};

const MERCED_LAT = 37.3022;
const MERCED_LON = -120.4830;

const computeDistanceToMerced = (cityName) => {
  const coordinates = {
    "merced": { lat: 37.3022, lon: -120.4830 },
    "turlock": { lat: 37.4947, lon: -120.8466 },
    "modesto": { lat: 37.6391, lon: -120.9969 },
    "manteca": { lat: 37.7974, lon: -121.2161 },
    "stockton": { lat: 37.9577, lon: -121.2908 },
    "tracy": { lat: 37.7397, lon: -121.4260 },
    "patterson": { lat: 37.4716, lon: -121.1297 }
  };
  
  const cleanName = cityName.split(",")[0].toLowerCase().trim();
  const target = coordinates[cleanName];
  if (!target) return null;

  const R = 3958.8;
  const dLat = ((target.lat - MERCED_LAT) * Math.PI) / 180;
  const dLon = ((target.lon - MERCED_LON) * Math.PI) / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((MERCED_LAT * Math.PI) / 180) * Math.cos((target.lat * Math.PI) / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
};

const ts = () => new Date().toLocaleTimeString([], { hour12: false });

export default function AmazonJobRadar() {
  const [cities] = useState(["Merced", "Turlock", "Modesto", "Patterson", "Manteca", "Tracy", "Stockton"]);
  const [activeCityIdx, setActiveCityIdx] = useState(0);
  const [jobType, setJobType] = useState("all");
  const [payFloor, setPayFloor] = useState(18.00);
  const [recipientEmail, setRecipientEmail] = useState("");

  const [jobs, setJobs] = useState([]);
  const [logs, setLogs] = useState([]);
  const [isPolling, setIsPolling] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(90);
  const [metrics, setMetrics] = useState({ totalScans: 0, alertsSent: 0, uniqueHits: 0 });
  const [netStatus, setNetStatus] = useState("stable");

  const addLog = useCallback((text, type = "info") => {
    const symbol = type === "error" ? "❌" : type === "success" ? "✅" : "⚡";
    setLogs(p => [`[${ts()}] ${symbol} ${text}`, ...p].slice(0, 100));
  }, []);

  useEffect(() => {
    fetchSavedJobsFromDB().then(savedList => {
      if (savedList?.length) {
        setJobs(savedList.sort((a, b) => b.timestamp - a.timestamp));
        setMetrics(m => ({ ...m, uniqueHits: savedList.length }));
        addLog(`Hydrated ${savedList.length} items from local IndexedDB storage ledger.`, "success");
      }
    });
  }, [addLog]);

  const dispatchEmailAlert = async (jobInstance) => {
    if (!recipientEmail) return;
    try {
      const res = await fetch("/api/alerts/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: jobInstance, recipientEmail })
      });
      if (res.ok) {
        addLog(`Email tracking alert successfully sent for ${jobInstance.title}.`, "success");
        setMetrics(m => ({ ...m, alertsSent: m.alertsSent + 1 }));
      } else {
        const errText = await res.text();
        addLog(`Email fail: ${errText}`, "error");
      }
    } catch (err) {
      addLog(`Email notification network error: ${err.message}`, "error");
    }
  };

  const runEngineScanCycle = useCallback(async () => {
    setNetStatus("scanning");
    const currentCity = cities[activeCityIdx];
    addLog(`Scanning upstream feeds for jobs in ${currentCity}, CA...`, "info");

    try {
      const res = await fetch("/api/amazon-jobs-v2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetCity: currentCity,
          queryKeyword: `Amazon warehouse ${jobType !== "all" ? jobType : ""}`.trim()
        })
      });

      if (!res.ok) throw new Error(`HTTP Upstream Status ${res.status}`);
      const rawPayload = await res.json();
      
      if (!rawPayload || !rawPayload.length) {
        addLog(`No active job data modifications found for ${currentCity}.`, "info");
        return;
      }

      let freshCount = 0;

      for (const item of rawPayload) {
        const parsedPayNum = parseFloat(item.pay.replace(/[^0-9.]/g, "")) || 0;
        if (parsedPayNum < payFloor && payFloor > 0) continue;

        const distanceMetric = computeDistanceToMerced(item.location || currentCity);
        const uniqueToken = `${item.title}-${item.location}-${parsedPayNum}`.toLowerCase().replace(/[^a-z0-9]/g, "");

        const structuredJob = {
          id: `job-${uniqueToken}`,
          title: item.title,
          location: item.location,
          pay: item.pay,
          payNum: parsedPayNum,
          distance: distanceMetric || "Unknown",
          description: item.description,
          applyUrl: item.applyUrl,
          timestamp: Date.now(),
          discoveredString: ts()
        };

        let wasAdded = false;
        setJobs(currentList => {
          if (!currentList.some(j => j.id === structuredJob.id)) {
            wasAdded = true;
            persistJobToDB(structuredJob);
            return [structuredJob, ...currentList].slice(0, 50);
          }
          return currentList;
        });

        if (wasAdded) {
          freshCount++;
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            new Notification("🚨 High Priority Amazon Job Found", {
              body: `${structuredJob.title} - ${structuredJob.pay} (${distanceMetric} mi from Merced)`
            });
          }
          await dispatchEmailAlert(structuredJob);
        }
      }

      if (freshCount > 0) {
        addLog(`Integrated ${freshCount} unindexed openings into registry.`, "success");
        setMetrics(m => ({ ...m, uniqueHits: m.uniqueHits + freshCount }));
      } else {
        addLog(`Clean pass completed for ${currentCity}. No new unique entries matched constraints.`, "info");
      }

      setMetrics(m => ({ ...m, totalScans: m.totalScans + 1 }));
      setNetStatus("stable");
    } catch (err) {
      addLog(`Execution pipeline block error: ${err.message}`, "error");
      setNetStatus("fault");
    } finally {
      setTimeRemaining(90);
      setActiveCityIdx(prev => (prev + 1) % cities.length);
    }
  }, [activeCityIdx, cities, jobType, payFloor, recipientEmail, addLog]);

  useEffect(() => {
    if (!isPolling) return;
    runEngineScanCycle();
    const ticker = setInterval(() => {
      setTimeRemaining(t => {
        if (t <= 1) {
          runEngineScanCycle();
          return 90;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(ticker);
  }, [isPolling, runEngineScanCycle]);

  return (
    <div style={{ padding: "24px", background: "#0f172a", minHeight: "100vh", color: "#f8fafc", fontFamily: "system-ui" }}>
      <header style={{ background: "linear-gradient(135deg, #1e3a8a, #1e1b4b)", padding: "24px", borderRadius: "12px", border: "1px solid #1e40af", marginBottom: "24px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "16px" }}>
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "28px", fontWeight: "800", color: "#38bdf8" }}>AMAZON LOGISTICS PIPELINE RADAR</h1>
          <p style={{ margin: "0", color: "#94a3b8", fontSize: "14px" }}>High-frequency full-stack deployment tracking regional logistics feeds.</p>
        </div>
        <div style={{ display: "flex", gap: "16px" }}>
          <div style={{ textAlign: "center", background: "#020617", padding: "8px 16px", borderRadius: "8px", border: "1px solid #334155" }}>
            <div style={{ fontSize: "12px", color: "#64748b" }}>TOTAL SCANS</div>
            <div style={{ fontSize: "20px", fontWeight: "700", color: "#38bdf8" }}>{metrics.totalScans}</div>
          </div>
          <div style={{ textAlign: "center", background: "#020617", padding: "8px 16px", borderRadius: "8px", border: "1px solid #334155" }}>
            <div style={{ fontSize: "12px", color: "#64748b" }}>UNIQUE JOBS STORED</div>
            <div style={{ fontSize: "20px", fontWeight: "700", color: "#22c55e" }}>{metrics.uniqueHits}</div>
          </div>
        </div>
      </header>

      <section style={{ background: "#1e293b", padding: "20px", borderRadius: "12px", marginBottom: "24px", border: "1px solid #334155", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "20px" }}>
        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#94a3b8", marginBottom: "6px" }}>GEO-ROTATION CYCLE TRACK:</label>
          <div style={{ fontSize: "14px", fontWeight: "700" }}>{cities.join(" → ")}</div>
          <span style={{ fontSize: "11px", color: "#38bdf8" }}>Scanning Next: <strong>{cities[activeCityIdx]}</strong></span>
        </div>
        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#94a3b8", marginBottom: "6px" }}>ROLE TYPE FILTERS:</label>
          <select value={jobType} onChange={(e) => setJobType(e.target.value)} style={{ width: "100%", padding: "8px", background: "#0f172a", color: "#fff", border: "1px solid #475569", borderRadius: "6px" }}>
            <option value="all">All Warehouse Openings</option>
            <option value="Fulfillment">Fulfillment Associate</option>
            <option value="Sorting">Sortation Matrix</option>
          </select>
        </div>
        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#94a3b8", marginBottom: "6px" }}>MINIMUM COMPENSATION FLOOR ($):</label>
          <input type="number" step="0.25" value={payFloor} onChange={(e) => setPayFloor(parseFloat(e.target.value) || 0)} style={{ width: "100%", padding: "8px", background: "#0f172a", color: "#fff", border: "1px solid #475569", borderRadius: "6px" }} />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#94a3b8", marginBottom: "6px" }}>ALERT DISPATCH EMAIL ROUTE:</label>
          <input type="email" placeholder="enter email address" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} style={{ width: "100%", padding: "8px", background: "#0f172a", color: "#fff", border: "1px solid #475569", borderRadius: "6px" }} />
        </div>
      </section>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px", marginBottom: "24px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <button onClick={() => setIsPolling(!isPolling)} style={{ padding: "12px 24px", border: "none", borderRadius: "8px", fontWeight: "700", color: "#fff", cursor: "pointer", backgroundColor: isPolling ? "#ef4444" : "#22c55e" }}>
            {isPolling ? "TERMINATE AUTOMATED POLLING" : "START CORE HARVESTING ENGINE"}
          </button>
          {typeof window !== "undefined" && "Notification" in window && Notification.permission !== "granted" && (
            <button onClick={() => Notification.requestPermission()} style={{ padding: "12px 16px", border: "none", borderRadius: "8px", fontWeight: "600", color: "#fff", background: "#f59e0b", cursor: "pointer" }}>
              Request System OS Push Rights
            </button>
          )}
        </div>
        <div style={{ fontSize: "14px", background: "#1e293b", padding: "10px 20px", borderRadius: "30px", border: "1px solid #334155" }}>
          Network Status Layer: <strong style={{ color: netStatus === "scanning" ? "#38bdf8" : "#22c55e" }}>{netStatus.toUpperCase()}</strong> {isPolling && ` (Next sweep in ${timeRemaining}s)`}
        </div>
      </div>

      <main style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "24px", alignItems: "start" }}>
        <div>
          <h3 style={{ fontSize: "18px", color: "#38bdf8", borderBottom: "2px solid #334155", paddingBottom: "8px", marginTop: "0" }}>Live Verified Openings Registry ({jobs.length})</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", maxHeight: "560px", overflowY: "auto" }}>
            {jobs.length === 0 ? (
              <div style={{ textAlign: "center", color: "#64748b", padding: "40px", border: "2px dashed #334155", borderRadius: "8px" }}>Registry empty. Launch processing loop thread to scrape live metrics.</div>
            ) : (
              jobs.map((job) => (
                <article key={job.id} style={{ background: "#1e293b", padding: "16px", borderRadius: "8px", border: "1px solid #334155" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                    <h4 style={{ margin: "0 0 6px 0", color: "#f8fafc", fontSize: "18px" }}>{job.title}</h4>
                    <span style={{ background: "#020617", color: "#22c55e", padding: "4px 8px", borderRadius: "4px", fontSize: "13px", fontWeight: "700", whiteSpace: "nowrap" }}>{job.pay}</span>
                  </div>
                  <div style={{ display: "flex", gap: "16px", fontSize: "12px", color: "#94a3b8", marginBottom: "10px", flexWrap: "wrap" }}>
                    <span>📍 {job.location}</span>
                    <span style={{ color: typeof job.distance === 'number' && job.distance <= 35 ? "#38bdf8" : "#f59e0b" }}>🚗 {typeof job.distance === 'number' ? `${job.distance} miles from Merced Hub` : "Unknown Proximity"}</span>
                  </div>
                  <p style={{ fontSize: "12px", color: "#cbd5e1", margin: "0 0 12px 0", lineHeight: "1.5" }}>{job.description}</p>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
                    <a href={job.applyUrl} target="_blank" rel="noopener noreferrer" style={{ background: "#ff9900", color: "#000", padding: "6px 12px", borderRadius: "4px", fontWeight: "700", textDecoration: "none", fontSize: "12px" }}>Complete Application &rarr;</a>
                    <span style={{ fontSize: "11px", color: "#64748b" }}>Captured: {job.discoveredString}</span>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
        <div>
          <h3 style={{ fontSize: "18px", color: "#38bdf8", borderBottom: "2px solid #334155", paddingBottom: "8px", marginTop: "0" }}>System Processing Engine Telemetry</h3>
          <div style={{ background: "#020617", color: "#38bdf8", padding: "16px", borderRadius: "8px", fontFamily: "monospace", fontSize: "12px", height: "566px", overflowY: "auto", border: "1px solid #334155" }}>
            {logs.length === 0 ? (
              <div style={{ color: "#475569", fontStyle: "italic" }}>No runtime system telemetry events generated yet.</div>
            ) : (
              logs.map((log, i) => <div key={i} style={{ paddingBottom: "4px", borderBottom: "1px solid #0f172a", whiteSpace: "pre-wrap" }}>{log}</div>)
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
