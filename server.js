// 🔴 MUST be first for Azure App Insights later
require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const sdk = require("microsoft-cognitiveservices-speech-sdk");
const { TextAnalyticsClient, AzureKeyCredential } = require("@azure/ai-text-analytics");

const app = express();
const upload = multer({ dest: "/tmp/" });

app.use(express.static("."));
app.use(express.json());

/* -----------------------------
   🔧 FFmpeg PATH (Azure-safe)
------------------------------ */
const ffmpegPath = "/home/site/wwwroot/bin/ffmpeg";

/* -----------------------------
   🔊 Azure Speech Config
------------------------------ */
const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY,
    process.env.AZURE_SPEECH_REGION
);

speechConfig.outputFormat = sdk.OutputFormat.Detailed;

/* -----------------------------
   🧠 Azure Language Client
------------------------------ */
const languageClient = new TextAnalyticsClient(
    process.env.AZURE_LANGUAGE_ENDPOINT,
    new AzureKeyCredential(process.env.AZURE_LANGUAGE_KEY)
);

/* -----------------------------
   🎧 Convert ANY audio → WAV
------------------------------ */
function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {

        const command =
            `"${ffmpegPath}" -y -i "${inputPath}" -ac 1 -ar 16000 -f wav "${outputPath}"`;

        exec(command, (err, stdout, stderr) => {
            if (err) {
                console.error("FFmpeg error:", stderr);
                return reject(
                    new Error(`FFmpeg failed. Path tried: ${ffmpegPath}`)
                );
            }
            resolve(outputPath);
        });
    });
}

/* -----------------------------
   🎤 TRANSCRIBE (Azure Speech)
------------------------------ */
async function transcribe(filePath) {
    const wavPath = filePath + ".wav";
    await convertToWav(filePath, wavPath);

    return new Promise((resolve, reject) => {

        const audioConfig = sdk.AudioConfig.fromWavFileInput(
            fs.readFileSync(wavPath)
        );

        const recognizer = new sdk.SpeechRecognizer(
            speechConfig,
            audioConfig
        );

        recognizer.recognizeOnceAsync(result => {

            if (result.reason === sdk.ResultReason.RecognizedSpeech) {

                const detailed = JSON.parse(result.privJson);

                resolve({
                    transcript: result.text,
                    language: detailed.PrimaryLanguage?.Language || "en-US",
                    confidence: detailed.NBest?.[0]?.Confidence || 0,
                    duration_seconds: detailed.Duration / 10000000,
                    words: (detailed.NBest?.[0]?.Words || []).map(w => ({
                        word: w.Word,
                        offset: w.Offset / 10000000,
                        duration: w.Duration / 10000000,
                        confidence: w.Confidence
                    }))
                });

            } else if (result.reason === sdk.ResultReason.NoMatch) {
                reject({ status: 400, message: "No speech detected." });

            } else {
                const cancel = sdk.CancellationDetails.fromResult(result);
                reject({ status: 415, message: cancel.errorDetails });
            }

            recognizer.close();
        });
    });
}

/* -----------------------------
   🧠 LANGUAGE ANALYSIS
------------------------------ */
async function analyze(text) {
    const [sentiment] = await languageClient.analyzeSentiment([text]);
    const [phrases] = await languageClient.extractKeyPhrases([text]);
    const [entities] = await languageClient.recognizeEntities([text]);

    return {
        sentiment: sentiment.sentiment,
        keyPhrases: phrases.keyPhrases,
        entities: entities.entities.map(e => ({
            text: e.text,
            category: e.category
        }))
    };
}

/* -----------------------------
   📝 SUMMARY GENERATOR (REQUIRED)
------------------------------ */
function buildSummary(analysis) {

    const phraseCount = analysis.keyPhrases.length;
    const phraseText = analysis.keyPhrases.slice(0, 5).join(", ");

    const entityCounts = {};
    analysis.entities.forEach(e => {
        entityCounts[e.category] = (entityCounts[e.category] || 0) + 1;
    });

    const entitySummary = Object.entries(entityCounts)
        .map(([type, count]) => `${count} ${type}`)
        .join(", ");

    return `Your memo mentions ${phraseCount} key topics: ${phraseText}. 
The overall tone is ${analysis.sentiment}. 
I detected ${entitySummary}.`;
}

/* -----------------------------
   🔊 TEXT TO SPEECH
------------------------------ */
async function synthesize(text) {

    speechConfig.speechSynthesisVoiceName = "en-US-JennyNeural";
    speechConfig.speechSynthesisOutputFormat =
        sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

    return new Promise((resolve, reject) => {

        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

        synthesizer.speakTextAsync(text, res => {

            if (res.audioData) {
                resolve(Buffer.from(res.audioData).toString("base64"));
            } else {
                reject("TTS failed");
            }

            synthesizer.close();
        });
    });
}

/* -----------------------------
   🔁 FULL PIPELINE
------------------------------ */
app.post("/process", upload.single("audio"), async (req, res) => {

    if (!req.file)
        return res.status(400).json({ error: "No file uploaded" });

    const filePath = req.file.path;

    try {
        const stt = await transcribe(filePath);
        const analysis = await analyze(stt.transcript);
        const summary = buildSummary(analysis);
        const tts = await synthesize(summary);

        res.json({
            ...stt,
            analysis,
            summary,
            audio_base64: tts
        });

    } catch (err) {
        console.error(err);

        if (err.status) {
            res.status(err.status).json({ error: err.message });
        } else {
            res.status(500).json({ error: err.toString() });
        }

    } finally {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(filePath + ".wav")) fs.unlinkSync(filePath + ".wav");
    }
});

/* -----------------------------
   🚀 SERVER START
------------------------------ */
const port = process.env.PORT || 8080;

app.listen(port, () =>
    console.log(`Server running on port ${port}`)
);