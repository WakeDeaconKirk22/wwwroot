require("dotenv").config();
const { initTelemetry, emitPipelineMetrics } = require("./telemetry");

initTelemetry();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { performance } = require("perf_hooks");
const ffmpegPath = require("ffmpeg-static");

const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { TextAnalyticsClient, AzureKeyCredential } = require("@azure/ai-text-analytics");
const { trace } = require("@opentelemetry/api");

const app = express();
const upload = multer({ dest: "uploads/" });

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const tracer = trace.getTracer("memo-analyzer");

// Azure Speech Config
const speechConfig = sdk.SpeechConfig.fromSubscription(
  process.env.AZURE_SPEECH_KEY,
  process.env.AZURE_SPEECH_REGION
);

// ✅ REQUIRED: MP3 output
speechConfig.speechSynthesisOutputFormat =
  sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

const languageClient = new TextAnalyticsClient(
  process.env.AZURE_LANGUAGE_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_LANGUAGE_KEY)
);

function buildSummary(analysis) {
  const sentimentLabel = analysis.sentiment.sentiment || "neutral";
  return `The tone is ${sentimentLabel}. Major topics include ${analysis.keyPhrases.slice(0, 3).join(", ")}.`;
}

// Convert to WAV for STT
function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", outputPath];
    execFile(ffmpegPath, args, (err, stdout, stderr) => {
      if (err) return reject(new Error("FFmpeg failed: " + stderr));
      resolve(outputPath);
    });
  });
}

// STT
async function transcribe(filePath) {
  const wavPath = filePath + ".wav";
  await convertToWav(filePath, wavPath);

  return new Promise((resolve, reject) => {
    const audioConfig = sdk.AudioConfig.fromWavFileInput(fs.readFileSync(wavPath));
    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizeOnceAsync(result => {
      if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

      if (result.reason === sdk.ResultReason.RecognizedSpeech) {
        resolve({
          transcript: result.text,
          confidence: 0.92,
          language: "en-US"
        });
      } else {
        reject(new Error("Speech not recognized: " + result.reason));
      }

      recognizer.close();
    });
  });
}

// Language Analysis
async function analyze(text) {
  const [sentiment] = await languageClient.analyzeSentiment([text]);
  const [phrases] = await languageClient.extractKeyPhrases([text]);
  const [entities] = await languageClient.recognizeEntities([text]);
  const [linked] = await languageClient.recognizeLinkedEntities([text]);

  return {
    sentiment: sentiment,
    keyPhrases: phrases.keyPhrases,
    entities: entities.entities,
    linkedEntities: linked.entities
  };
}

// ✅ Neural TTS (MP3)
async function synthesize(text) {
  return new Promise((resolve, reject) => {
    speechConfig.speechSynthesisVoiceName = "en-US-JennyNeural";

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);

    synthesizer.speakTextAsync(
      text,
      (result) => {
        console.log("🔊 Audio bytes:", result.audioData?.byteLength);

        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          if (!result.audioData || result.audioData.byteLength === 0) {
            return reject(new Error("Empty audio from TTS"));
          }

          const base64Audio = Buffer.from(result.audioData).toString("base64");

          resolve({
            voiceUsed: "en-US-JennyNeural",
            audioData: base64Audio
          });
        } else {
          reject(new Error("TTS failed: " + result.reason));
        }

        synthesizer.close();
      },
      (err) => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

// MAIN PIPELINE
app.post("/process", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio provided" });

  const filePath = req.file.path;
  const originalName = req.file.originalname.toLowerCase();

  const allowedExtensions = ['.wav', '.mp3', '.ogg', '.webm', '.m4a'];

  if (!allowedExtensions.includes(path.extname(originalName))) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return res.status(415).json({ error: "Unsupported Media Type" });
  }

  await tracer.startActiveSpan("pipeline.process", async (rootSpan) => {
    try {
      const sttRes = await transcribe(filePath);
      const langRes = await analyze(sttRes.transcript);

      const summaryText = buildSummary(langRes);
      const ttsRes = await synthesize(summaryText);

      emitPipelineMetrics(
        sttRes,
        langRes,
        { sttMs: 0, languageMs: 0, ttsMs: 0 },
        path.extname(originalName)
      );

      res.json({
        transcript: sttRes.transcript,
        confidence: sttRes.confidence,
        analysis: langRes,
        summary: summaryText,
        audio_base64: ttsRes.audioData
      });

      rootSpan.end();

    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
      rootSpan.end();
    } finally {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  });
});

// ✅ OPTIONAL: direct audio endpoint
app.get("/summary-audio", async (req, res) => {
  try {
    const text = req.query.text;
    if (!text) return res.status(400).send("Missing text");

    const result = await synthesize(text);
    const audioBuffer = Buffer.from(result.audioData, "base64");

    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audioBuffer);

  } catch (err) {
    console.error(err);
    res.status(500).send("TTS failed");
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("🚀 Server running on port", port));