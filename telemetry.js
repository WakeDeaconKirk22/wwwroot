const { useAzureMonitor } = require("@azure/monitor-opentelemetry");
const { metrics } = require("@opentelemetry/api");

function initTelemetry() {
  if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    useAzureMonitor({
      azureMonitorExporterOptions: {
        connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
      }
    });
    console.log("Telemetry initialized.");
  } else {
    console.warn("Telemetry skipped: No connection string found.");
  }
}

const meter = metrics.getMeter("memo-analyzer");

// Histograms for Stage Latency (Step 33)
const sttHist = meter.createHistogram("stage_stt_ms");
const langHist = meter.createHistogram("stage_language_ms");
const ttsHist = meter.createHistogram("stage_tts_ms");

// Gauge for Confidence Alert (Step 32)
const sttGauge = meter.createObservableGauge("stt_confidence");
let lastConfidence = 0;

sttGauge.addCallback((obs) => {
  obs.observe(lastConfidence);
});

// Matches the call: emitPipelineMetrics(sttResult, langResult, timings, audioFormat)
function emitPipelineMetrics(stt, lang, timings, audioFormat) {
  try {
    // 1. Update Confidence Gauge
    lastConfidence = stt.confidence || 0;

    // 2. Map the attributes (Dimensions) for filtering in Azure Metrics
    const attributes = { "audio.format": audioFormat };

    // 3. Record the timings sent from server.js
    sttHist.record(timings.sttMs || 0, attributes);
    langHist.record(timings.languageMs || 0, attributes);
    ttsHist.record(timings.ttsMs || 0, attributes);

    console.log(`Telemetry Emitted: Confidence ${lastConfidence}, STT ${timings.sttMs}ms`);
  } catch (err) {
    console.error("Telemetry emission failed:", err.message);
  }
}

// Added this to prevent crashes if server.js calls it
function emitPipelineEvent(stt, lang, format) {
  console.log("Pipeline event tracked locally.");
}

module.exports = { initTelemetry, emitPipelineMetrics, emitPipelineEvent };