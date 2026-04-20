// telemetry.js
require("dotenv").config();
const { useAzureMonitor } = require("@azure/monitor-opentelemetry");
const { metrics, trace } = require("@opentelemetry/api");

function initTelemetry() {
    const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    if (!connectionString) {
        throw new Error("APPLICATIONINSIGHTS_CONNECTION_STRING not set in .env");
    }
    useAzureMonitor({ azureMonitorExporterOptions: { connectionString } });
    console.log("Application Insights initialized.");
}

// --- Metrics Setup (G3) ---
const meter = metrics.getMeter("memo-analyzer");
const sttConfidenceGauge = meter.createObservableGauge("stt_confidence");
const sttDurationGauge = meter.createObservableGauge("stt_duration_seconds");
const entityCountGauge = meter.createObservableGauge("language_entity_count");
const sentimentGauge = meter.createObservableGauge("language_sentiment");
const stageSttHist = meter.createHistogram("stage_stt_ms");
const stageLanguageHist = meter.createHistogram("stage_language_ms");
const stageTtsHist = meter.createHistogram("stage_tts_ms");

let lastMetrics = { sttResult: {}, languageResult: {}, ttsResult: {}, attrs: {} };

// Callbacks for Observable Gauges
sttConfidenceGauge.addCallback((obs) => obs.observe(lastMetrics.sttResult.confidence || 0, lastMetrics.attrs));
sttDurationGauge.addCallback((obs) => obs.observe(lastMetrics.sttResult.duration_seconds || 0, lastMetrics.attrs));
entityCountGauge.addCallback((obs) => obs.observe(lastMetrics.languageResult.entities?.length || 0, lastMetrics.attrs));

const sentimentMap = { positive: 1.0, neutral: 0.0, negative: -1.0 };
sentimentGauge.addCallback((obs) => {
    const score = sentimentMap[lastMetrics.languageResult.sentiment] ?? 0.0;
    obs.observe(score, lastMetrics.attrs);
});

function emitPipelineMetrics(sttResult, languageResult, ttsResult, stageTimings, audioFormat) {
    const attrs = { audio_format: audioFormat, language: sttResult.language || "en-US" };
    lastMetrics = { sttResult, languageResult, ttsResult, attrs };
    
    // Record Histogram values
    stageSttHist.record(stageTimings.sttMs, attrs);
    stageLanguageHist.record(stageTimings.languageMs, attrs);
    stageTtsHist.record(stageTimings.ttsMs, attrs);
}

// --- Tracing & Events (G4 & G5) ---
const tracer = trace.getTracer("memo-analyzer");

function emitPipelineEvent(sttResult, langResult, audioFormat, success = true, errorStage = null, errorMsg = null) {
    const span = trace.getActiveSpan();
    if (!span) return;

    if (success) {
        span.setAttribute("event.name", "pipeline_completed");
        span.setAttribute("stt.confidence", sttResult?.confidence || 0);
        span.setAttribute("stt.language", sttResult?.language || "en-US");
        span.setAttribute("entities.count", langResult?.entities?.length || 0);
        span.setAttribute("sentiment", langResult?.sentiment || "neutral");
        span.setAttribute("audio.format", audioFormat);
    } else {
        span.setAttribute("event.name", "pipeline_error");
        span.setAttribute("error.stage", errorStage);
        span.setAttribute("error.message", errorMsg);
        span.recordException(new Error(errorMsg));
    }
}

/**
 * Utility to time async functions (Required for G3 logic)
 */
async function timedStage(fn, ...args) {
    const start = performance.now();
    const result = await fn(...args);
    const elapsedMs = performance.now() - start;
    return [result, elapsedMs];
}

module.exports = { 
    initTelemetry, 
    emitPipelineMetrics, 
    emitPipelineEvent, 
    tracer, 
    timedStage 
};