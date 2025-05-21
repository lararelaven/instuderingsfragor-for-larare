// Ladda miljövariabler från .env-filen
const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const { execFile } = require('child_process'); // execFile är tillräckligt
const fs = require('fs').promises;
const fsc = require('fs'); // Importera synkrona fs för existsSync
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto'); // För unika jobb-ID

const app = express();
const PORT = process.env.PORT || 3000;

const NOVITA_API_KEY = process.env.NOVITA_API_KEY;
const NOVITA_API_ENDPOINT = process.env.NOVITA_API_ENDPOINT;
const NOVITA_MODEL_NAME = process.env.NOVITA_MODEL_NAME;

const NOVITA_STT_API_ENDPOINT = process.env.NOVITA_STT_API_ENDPOINT;
const NOVITA_WHISPER_MODEL_NAME = process.env.NOVITA_WHISPER_MODEL_NAME;

if (!NOVITA_API_KEY || !NOVITA_API_ENDPOINT || !NOVITA_MODEL_NAME) {
    console.warn("VARNING: Novita.ai API-konfiguration (LLM) är inte fullständigt satt i .env-filen.");
}
if (!NOVITA_STT_API_ENDPOINT || !NOVITA_API_KEY || !NOVITA_WHISPER_MODEL_NAME) {
    console.warn("VARNING: Novita.ai STT API-konfiguration är inte fullständigt satt. STT-funktionalitet kan misslyckas.");
}


// Globalt objekt för att lagra jobbstatus (in-memory)
const videoDownloadJobs = {};
/*
  Struktur för videoDownloadJobs:
  jobId: {
    status: 'pending' | 'processing' | 'completed' | 'failed',
    mediaLink: '...',
    filePath: '...' (när klar),
    fileName: '...' (när klar),
    error: '...' (om misslyckat),
    createdAt: Date,
    updatedAt: Date,
  }
*/

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname))); // Serverar index.html, script.js, styles.css

// --- HJÄLPFUNKTIONER ---
function isValidUrl(url) {
    if (!url || typeof url !== 'string' || url.trim() === '') return false;
    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();
        // Acceptera även youtube.com och youtu.be direkt
        return hostname.includes('svtplay.se') ||
            hostname.includes('urplay.se') ||
            hostname.includes('youtube.com') ||
            hostname.includes('youtu.be') ||
            hostname.includes('youtube-nocookie.com') ||
            hostname.includes('youtube.com') || // För Android-delningslänkar
            hostname.includes('youtu.be');
    } catch (e) {
        return false;
    }
}

const execFilePromise = (command, args, options) => {
    return new Promise((resolveExec, rejectExec) => {
        console.log(`Executing: ${command} ${args.join(' ')}`);
        const child = execFile(command, args, options, (error, stdout, stderr) => {
            if (error) {
                console.error(`\n--- ${command} execFile error ---`);
                console.error(`Message: ${error.message}`);
                console.error(`Code: ${error.code}`);
                if (error.stderr) console.error(`Stderr (from error obj):\n${error.stderr}`);
                if (error.stdout) console.error(`Stdout (from error obj):\n${error.stdout}`);
                
                // Attach stderr and stdout to the error object if not already present
                error.stderr = error.stderr || stderr;
                error.stdout = error.stdout || stdout;
                return rejectExec(error);
            }
            // Logga stdout och stderr även vid framgång, för felsökning av varningsmeddelanden etc.
            if (stdout) console.log(`\n--- ${command} stdout (success) ---\n${stdout}`);
            if (stderr) { // Logga all stderr, men som info/warn om det inte är ett fel.
                 console.log(`\n--- ${command} stderr (success/info) ---\n${stderr}`);
            }
            resolveExec({ stdout, stderr }); // error-objektet är null här
        });

        child.on('spawn', () => {
            console.log(`Process ${command} (PID: ${child.pid}) spawned.`);
        });
        child.on('exit', (code, signal) => {
            console.log(`Process ${command} (PID: ${child.pid}) exited with code ${code}${signal ? ` and signal ${signal}` : ''}.`);
        });
        child.on('error', (spawnError) => { // För fel vid själva spawn (t.ex. ENOENT)
            console.error(`\n--- ${command} spawn error ---`);
            console.error(`Message: ${spawnError.message}`);
            console.error(`Code: ${spawnError.code}`);
            rejectExec(spawnError);
        });
    });
};


async function callNovitaSttApi(audioFilePath, language = 'sv') {
    const effectiveSttEndpoint = NOVITA_STT_API_ENDPOINT || 'https://api.novita.ai/v2/stt';
    const effectiveWhisperModel = NOVITA_WHISPER_MODEL_NAME || 'whisper-large-v3';

    if (!NOVITA_API_KEY) {
        throw new Error("Novita.ai API-nyckel (NOVITA_API_KEY) är inte satt i .env-filen.");
    }
    if (!fsc.existsSync(audioFilePath)) {
        throw new Error(`Ljudfilen kunde inte hittas: ${audioFilePath}`);
    }
    if (!NOVITA_STT_API_ENDPOINT) {
        console.warn("NOVITA_STT_API_ENDPOINT är inte konfigurerad i .env. STT-anrop kommer sannolikt att misslyckas.");
        throw new Error("NOVITA_STT_API_ENDPOINT är inte konfigurerad.");
    }

    console.log(`Anropar Novita.ai STT API (${effectiveSttEndpoint}) för fil: ${audioFilePath} med modell ${effectiveWhisperModel}`);

    const formData = new FormData();
    formData.append('file', fsc.createReadStream(audioFilePath));
    formData.append('model_name', effectiveWhisperModel);
    formData.append('language', language);
    formData.append('response_format', 'srt');

    try {
        const response = await axios.post(effectiveSttEndpoint, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${NOVITA_API_KEY}`,
            },
            timeout: 1800000, // 30 min timeout
        });

        if (response.data) {
            if (typeof response.data === 'string' && response.data.includes('-->') && response.data.match(/^\d+\s*\n\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/m)) {
                console.log("Novita.ai STT API returnerade SRT-data direkt.");
                return response.data;
            }
            else if (response.data.srt && typeof response.data.srt === 'string' && response.data.srt.includes('-->')) {
                console.log("Novita.ai STT API returnerade SRT-data i ett 'srt'-fält.");
                return response.data.srt;
            }
            else if (response.data.text && Array.isArray(response.data.segments)) {
                console.log("Novita.ai STT API returnerade text och segment. Formaterar till SRT...");
                let srtContent = "";
                let segmentIndex = 1;

                const formatSrtTimestamp = (totalSeconds) => {
                    const hours = Math.floor(totalSeconds / 3600);
                    const minutes = Math.floor((totalSeconds % 3600) / 60);
                    const seconds = Math.floor(totalSeconds % 60);
                    const milliseconds = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1000);
                    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
                };

                for (const segment of response.data.segments) {
                    if (typeof segment.start === 'number' && typeof segment.end === 'number' && typeof segment.text === 'string') {
                        const start = formatSrtTimestamp(segment.start);
                        const end = formatSrtTimestamp(segment.end);
                        let segmentText = segment.text.trim();
                        const MAX_LINE_LENGTH = 42; // Standard SRT maxlängd
                        let lines = [];
                        while (segmentText.length > MAX_LINE_LENGTH) {
                            let breakPoint = segmentText.lastIndexOf(' ', MAX_LINE_LENGTH);
                            if (breakPoint === -1) breakPoint = MAX_LINE_LENGTH;
                            lines.push(segmentText.substring(0, breakPoint));
                            segmentText = segmentText.substring(breakPoint).trim();
                        }
                        lines.push(segmentText);
                        const formattedText = lines.join('\n');

                        srtContent += `${segmentIndex++}\n${start} --> ${end}\n${formattedText}\n\n`;
                    }
                }
                if (srtContent) return srtContent;
                if (response.data.text) {
                    console.warn("Kunde inte formatera detaljerad SRT från Novita STT-segment, använder råtext med dummy-tidsstämpel.");
                    return `1\n00:00:00,000 --> 00:01:00,000\n${response.data.text.trim()}\n\n`;
                }
                throw new Error('Novita.ai STT API returnerade segment i oväntat format eller ingen text.');
            } else if (response.data.text) {
                console.warn("Novita STT returnerade bara text, använder dummy-tidsstämpel.");
                return `1\n00:00:00,000 --> 00:01:00,000\n${response.data.text.trim()}\n\n`;
            } else if (response.data.transcript) {
                 console.warn("Novita STT returnerade 'transcript', använder dummy-tidsstämpel.");
                return `1\n00:00:00,000 --> 00:01:00,000\n${response.data.transcript.trim()}\n\n`;
            }
            console.log('Novita.ai STT API svar (okänt format):', JSON.stringify(response.data, null, 2));
            throw new Error('Novita.ai STT API returnerade data i ett oväntat format.');
        }
        throw new Error('Inget data mottogs från Novita.ai STT API.');

    } catch (error) {
        console.error(`Fel vid anrop till Novita.ai STT API:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        const errorDetail = error.response && error.response.data ? (error.response.data.message || error.response.data.detail || JSON.stringify(error.response.data)) : error.message;
        throw new Error(`Novita.ai STT API-fel: ${errorDetail}`);
    }
}

async function getSrtFile(mediaLink) {
    if (!isValidUrl(mediaLink)) {
        throw new Error('Ogiltig eller ej stödd media-länk i getSrtFile.');
    }

    const parsedUrl = new URL(mediaLink);
    const hostname = parsedUrl.hostname.toLowerCase();
    const isYoutube = hostname.includes('youtube.com') || hostname.includes('youtu.be') || hostname.includes('youtube-nocookie.com') || hostname.includes('youtube.com');

    const uniqueFileId = Date.now();
    const tempDir = os.tmpdir();
    const uniqueFileNameBaseNoExt = path.join(tempDir, `media_temp_subs_${uniqueFileId}`);
    // Skapa mappen för att säkerställa att yt-dlp kan skriva dit
    await fs.mkdir(uniqueFileNameBaseNoExt, { recursive: true }).catch(e => console.warn(`Kunde inte skapa mapp för undertexter: ${uniqueFileNameBaseNoExt}`, e));


    let srtDownloaderCommand;
    let srtDownloaderArgs;
    let srtFilePathToCheck; // Vi behöver veta exakt var filen hamnar

    if (isYoutube) {
        srtDownloaderCommand = '/opt/venv/bin/yt-dlp'; // Absolut sökväg
        srtFilePathToCheck = `${uniqueFileNameBaseNoExt}.sv.srt`; // yt-dlp kommer att skapa en fil med språkkod
        srtDownloaderArgs = [
            '--no-warnings', '--write-sub', '--write-auto-sub', '--convert-subs', 'srt',
            '--sub-langs', 'sv.*,en.*', // Prioritera svenska, sedan engelska
            '--sub-format', 'srt/vtt/best', '--skip-download',
            // Viktigt: -o specificerar output template. Eftersom vi skapar mappen uniqueFileNameBaseNoExt,
            // och yt-dlp skapar filnamn baserat på videons titel, måste vi peka outputen *inuti* den mappen.
            // Vi låter yt-dlp skapa filnamnet baserat på videons titel, men i den specificerade mappen.
            '-o', path.join(uniqueFileNameBaseNoExt, '%(title)s.%(ext)s'), // Lägger till %(title)s.%(ext)s
            mediaLink
        ];
        console.log(`Försöker hämta YT undertexter. Förväntar mig fil i mappen: ${uniqueFileNameBaseNoExt}`);
    } else { // SVT/UR
        srtDownloaderCommand = '/opt/venv/bin/svtplay-dl'; // Absolut sökväg
        srtDownloaderArgs = [
            '-S', '--force-subtitle',
            // svtplay-dl kommer att skapa filen *i* mappen uniqueFileNameBaseNoExt
            '-o', uniqueFileNameBaseNoExt, // Output till mappen, svtplay-dl sköter filnamnet
            mediaLink
        ];
        console.log(`Försöker hämta SVT/UR undertexter. Filer hamnar i: ${uniqueFileNameBaseNoExt}`);
    }

    console.log(`Hämtar undertexter med: ${srtDownloaderCommand} ${srtDownloaderArgs.join(' ')}`);
    await execFilePromise(srtDownloaderCommand, srtDownloaderArgs, { timeout: 180000 }); // 3 min timeout

    // Leta efter .srt-filen i den skapade mappen
    const filesInOutputDir = await fs.readdir(uniqueFileNameBaseNoExt).catch(() => []);
    let downloadedSrtFile = filesInOutputDir.find(f => f.endsWith('.srt'));

    if (downloadedSrtFile) {
        const finalSrtPath = path.join(uniqueFileNameBaseNoExt, downloadedSrtFile);
        console.log(`Hittade nedladdad SRT-fil: ${finalSrtPath}`);
        try {
            const srtFileData = await fs.readFile(finalSrtPath, 'utf-8');
            if (srtFileData && srtFileData.trim() !== '') {
                console.log("Undertexter hämtade direkt.");
                await fs.rm(uniqueFileNameBaseNoExt, { recursive: true, force: true }).catch(e => console.warn(`Kunde inte radera temp-mapp för undertexter (1): ${uniqueFileNameBaseNoExt}`, e));
                return srtFileData;
            }
            console.log("Nedladdad SRT-fil var tom.");
        } catch (fileError) {
            console.warn(`Fel vid läsning av nedladdad SRT-fil: ${fileError.message}. Fortsätter.`);
        }
    }
    
    // Om ingen SRT hittades direkt, och det är YouTube, försök STT
    if (isYoutube && NOVITA_STT_API_ENDPOINT && NOVITA_API_KEY) {
        console.log("Inga befintliga undertexter hittades för YouTube-länk. Försöker transkribera ljud via Novita.ai STT...");
        const audioFileOutputDir = path.join(tempDir, `media_temp_audio_${uniqueFileId}`);
        await fs.mkdir(audioFileOutputDir, { recursive: true }).catch(e => console.warn(`Kunde inte skapa mapp för ljud: ${audioFileOutputDir}`, e));
        
        const audioDlCommand = '/opt/venv/bin/yt-dlp'; // Absolut sökväg
        const audioDlArgs = [
            '--no-warnings', '-x', '-f', 'bestaudio', '--audio-format', 'wav',
            '-o', path.join(audioFileOutputDir, '%(title)s.%(ext)s'), // Output audio till sin egen mapp
            mediaLink
        ];

        console.log(`Laddar ner ljud: ${audioDlCommand} ${audioDlArgs.join(' ')}`);
        await execFilePromise(audioDlCommand, audioDlArgs, { timeout: 600000 }); // 10 min timeout

        const audioFiles = await fs.readdir(audioFileOutputDir).catch(() => []);
        const actualAudioFile = audioFiles.find(f => f.endsWith('.wav'));

        if (!actualAudioFile) {
            await fs.rm(uniqueFileNameBaseNoExt, { recursive: true, force: true }).catch(() => {});
            await fs.rm(audioFileOutputDir, { recursive: true, force: true }).catch(() => {});
            throw new Error(`Ljudfil .wav kunde inte hittas efter nedladdningsförsök i ${audioFileOutputDir}.`);
        }
        const audioFilePath = path.join(audioFileOutputDir, actualAudioFile);

        console.log(`Ljudfil nedladdad till: ${audioFilePath}. Startar transkribering...`);
        try {
            const transcribedSrtData = await callNovitaSttApi(audioFilePath, 'sv');
            console.log("Transkribering via Novita.ai STT lyckades.");
            await fs.rm(uniqueFileNameBaseNoExt, { recursive: true, force: true }).catch(() => {});
            await fs.rm(audioFileOutputDir, { recursive: true, force: true }).catch(() => {});
            return transcribedSrtData;
        } catch (sttError) {
            console.error(`Fel vid transkribering via Novita.ai STT: ${sttError.message}`);
            await fs.rm(uniqueFileNameBaseNoExt, { recursive: true, force: true }).catch(() => {});
            await fs.rm(audioFileOutputDir, { recursive: true, force: true }).catch(() => {});
            throw new Error(`Transkribering via Novita.ai STT misslyckades: ${sttError.message}`);
        }
    }

    await fs.rm(uniqueFileNameBaseNoExt, { recursive: true, force: true }).catch(e => console.warn(`Kunde inte radera temp-mapp för undertexter (final): ${uniqueFileNameBaseNoExt}`, e));
    if (isYoutube) {
         throw new Error('Inga undertexter hittades och STT-tjänsten är inte (fullständigt) konfigurerad eller misslyckades.');
    } else {
        throw new Error('Inga undertexter kunde hittas eller genereras för denna media.');
    }
}

function parseAndSlimSrt(srtData) {
    let srtContentToParse = srtData.replace(/\r\n/g, '\n'); // Normalisera radbrytningar
    if (srtContentToParse.charCodeAt(0) === 0xFEFF) { // Ta bort BOM
        srtContentToParse = srtContentToParse.substring(1);
    }

    const blocks = srtContentToParse.split(/\n\n+/); // Dela upp i block
    let slimmedSrt = "";
    for (const block of blocks) {
        if (block.trim() === "") continue; // Hoppa över tomma block

        const lines = block.trim().split('\n');
        let timeLineIndex = -1;
        for (let i = 0; i < lines.length; i++) { // Hitta tidslinjen
            if (lines[i].includes('-->')) {
                timeLineIndex = i;
                break;
            }
        }

        if (timeLineIndex === -1) { // Om ingen tidslinje, logga och hoppa över (eller hantera som text om det är enda blocket)
             if (blocks.length === 1 && lines.length > 0 && lines[0].trim() !== "") {
                const textContent = lines.join('\n').trim();
                if (textContent) {
                    console.warn("SRT-block saknar tidsstämpel, använder dummy-tid för hela blocket:", block.substring(0, 100));
                    slimmedSrt += `[00:00] --> [00:00]\n${textContent}\n\n`;
                }
            } else {
                console.warn("SRT-block saknar '-->' tidslinje:", lines.join(' | ').substring(0,100));
            }
            continue;
        }
        
        // Försök parsa tidsformat hh:mm:ss,mmm eller mm:ss,mmm eller ss,mmm
        const timeMatch = lines[timeLineIndex].match(/(\d{1,2}:)?(\d{1,2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:)?(\d{1,2}:\d{2}[,.]\d{3})/);

        if (timeMatch) {
            let startStr = timeMatch[1] ? timeMatch[1] + timeMatch[2] : timeMatch[2]; // Inkludera timmar om de finns
            let endStr = timeMatch[3] ? timeMatch[3] + timeMatch[4] : timeMatch[4];

            // Förenkla formatet till [mm:ss] eller [hh:mm:ss]
            const formatShortTime = (timeStrWithMs) => {
                const parts = timeStrWithMs.split(/[:,.]/); // Dela vid :, . eller ,
                let h = "00", m = "00", s = "00";
                if (parts.length === 4) { // hh:mm:ss,ms
                    [h, m, s] = parts.slice(0,3);
                } else if (parts.length === 3) { // mm:ss,ms
                    [m, s] = parts.slice(0,2);
                } else if (parts.length === 2) { // ss,ms - mindre troligt men för säkerhets skull
                    s = parts[0];
                }
                return (parseInt(h,10) > 0 ? `${h.padStart(2,'0')}:` : '') + `${m.padStart(2,'0')}:${s.padStart(2,'0')}`;
            };
            
            const formattedStartTime = formatShortTime(startStr);
            const formattedEndTime = formatShortTime(endStr);

            const textContent = lines.slice(timeLineIndex + 1).join('\n').trim();
            if (textContent) { // Lägg bara till om det finns text
                slimmedSrt += `[${formattedStartTime}] --> [${formattedEndTime}]\n${textContent}\n\n`;
            }
        } else {
            console.warn("Okänt tidsformat i SRT-block efter försök att parsa:", lines[timeLineIndex]);
        }
    }
    return slimmedSrt.trim();
}

function deduplicateSlimmedSrt(slimmedSrtString) {
    if (!slimmedSrtString || slimmedSrtString.trim() === "") {
        return "";
    }
    const entries = [];
    const rawBlocks = slimmedSrtString.trim().split(/\n\n+/);

    // Steg 1: Parsa blocken till en strukturerad lista
    for (const block of rawBlocks) {
        const lines = block.split('\n');
        if (lines.length < 2 || !lines[0].includes("-->")) {
            // console.warn("Deduplicate: Hoppar över block utan valid tidsrad:", block.substring(0,50));
            continue; 
        }
        entries.push({ timeLine: lines[0], originalText: lines.slice(1).join('\n').trim() });
    }

    if (entries.length === 0) {
        return "";
    }

    const cleanedEntries = [];
    let lastPushedFullText = ""; // Håll reda på hela den text som senast lades till eller byggdes på

    for (let i = 0; i < entries.length; i++) {
        const currentEntry = entries[i];
        const currentOriginalText = currentEntry.originalText;

        if (cleanedEntries.length > 0) {
            const lastCleanedEntry = cleanedEntries[cleanedEntries.length - 1];

            // 1. Exakt samma text som den förra PUSHADE texten -> uppdatera bara tid för den förra.
            if (currentOriginalText === lastPushedFullText) {
                lastCleanedEntry.timeLine = currentEntry.timeLine; // Uppdatera sluttiden på den förra
                continue; // Hoppa över att lägga till denna, då den är identisk med vad som redan hanterats
            }

            // 2. Om nuvarande text börjar med den FÖREGÅENDE PUSHADE texten och lägger till nytt.
            if (currentOriginalText.startsWith(lastPushedFullText) && currentOriginalText.length > lastPushedFullText.length) {
                const newAppendedText = currentOriginalText.substring(lastPushedFullText.length).trim();
                if (newAppendedText) {
                    // Uppdatera den föregående posten med den nya texten och den nya tiden.
                    lastCleanedEntry.text = (lastCleanedEntry.text + " " + newAppendedText).trim();
                    lastCleanedEntry.timeLine = currentEntry.timeLine;
                    lastPushedFullText = currentOriginalText; // Uppdatera vad som senast pushades
                } else { 
                    // Om det inte finns någon ny text (bara mellanslag), uppdatera bara tiden.
                    lastCleanedEntry.timeLine = currentEntry.timeLine;
                    lastPushedFullText = currentOriginalText; 
                }
                continue;
            }
        }
        
        // Om det är första posten, eller om den inte är relaterad till den föregående på ett uppenbart sätt
        if (currentOriginalText.trim()) { // Lägg bara till om det finns text
            cleanedEntries.push({ timeLine: currentEntry.timeLine, text: currentOriginalText });
            lastPushedFullText = currentOriginalText;
        }
    }
    
    // Ytterligare ett svep för att slå ihop identiska på varandra följande textblock
    // (som kan ha uppstått efter den första rensningen)
    if (cleanedEntries.length < 2) {
        return cleanedEntries.map(entry => `${entry.timeLine}\n${entry.text}`).join('\n\n');
    }

    const finalEntries = [cleanedEntries[0]];
    for (let i = 1; i < cleanedEntries.length; i++) {
        if (cleanedEntries[i].text === finalEntries[finalEntries.length - 1].text) {
            finalEntries[finalEntries.length - 1].timeLine = cleanedEntries[i].timeLine; // Behåll den senare tiden
        } else {
            finalEntries.push(cleanedEntries[i]);
        }
    }

    return finalEntries.map(entry => `${entry.timeLine}\n${entry.text}`).join('\n\n');
}

async function callNovitaAI(messages, temperature, top_p, requestSourceLabel, max_tokens = 4050) {
    if (!NOVITA_API_KEY || !NOVITA_API_ENDPOINT || !NOVITA_MODEL_NAME) {
        console.error("Novita.ai API-konfiguration (LLM) är inte fullständigt satt.");
        throw new Error("Novita.ai API-konfiguration (LLM) är ofullständig. Kontrollera .env-filen.");
    }

    console.log(`Anropar Novita.ai LLM för: ${requestSourceLabel}. Modell: ${NOVITA_MODEL_NAME}. Max tokens: ${max_tokens}, Temp: ${temperature}`);
    
    const requestBody = {
        model: NOVITA_MODEL_NAME,
        messages: messages,
        temperature: temperature,
        top_p: top_p,
        max_tokens: max_tokens 
    };

    try {
        const response = await axios.post(NOVITA_API_ENDPOINT, requestBody, {
            headers: {
                'Authorization': `Bearer ${NOVITA_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 180000 // 3 minuter timeout
        });

        if (response.data && response.data.choices && response.data.choices.length > 0 && response.data.choices[0].message && response.data.choices[0].message.content) {
            console.log(`Svar mottaget från Novita.ai LLM för ${requestSourceLabel}.`);
            return response.data.choices[0].message.content;
        } else {
            console.error('Novita.ai LLM API-svar hade oväntat format:', response.data);
            throw new Error('Novita.ai LLM API-svar hade oväntat format. Inget textinnehåll hittades.');
        }
    } catch (error) {
        console.error(`Novita.ai LLM API-fel för ${requestSourceLabel}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        if (error.response && error.response.data && error.response.data.reason === "MODEL_NOT_FOUND") {
             throw new Error(`Novita.ai LLM API-fel: MODEL_NOT_FOUND. Kontrollera att modellen "${NOVITA_MODEL_NAME}" är korrekt och tillgänglig via endpointen "${NOVITA_API_ENDPOINT}".`);
        }
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
             throw new Error(`Novita.ai LLM API-fel: Timeout vid anrop (${error.message}). Försök igen senare eller justera timeout-inställningen.`);
        }
        const errorDetail = error.response && error.response.data ? (error.response.data.message || error.response.data.detail || JSON.stringify(error.response.data)) : error.message;
        throw new Error(`Novita.ai LLM API-fel: ${errorDetail}`);
    }
}

function sanitizeAiGeneratedText(text, sourceLabel = "Okänd") {
    if (typeof text !== 'string') {
        console.warn(`sanitizeAiGeneratedText: input var inte en sträng för ${sourceLabel}. Returnerar tom sträng.`);
        return "";
    }
    let cleanedText = text;
    // Lista med regex för att ta bort vanliga inledande fraser
    const commonLeadingPhrases = [
        /^\s*Här är (de begärda|dina) frågorna baserat på undertexten:*\s*\n*/im,
        /^\s*Här är (de begärda|dina) instuderingsfrågorna:*\s*\n*/im,
        /^\s*Här är (ett förslag på|dina) (elevfrågor|lärarsvar|facit):*\s*\n*/im,
        /^\s*Baserat på den givna undertexten, här är (frågorna|svaren):*\s*\n*/im,
        /^\s*Okej, här kommer (frågorna|svaren):*\s*\n*/im,
        /^\s*Visst, här är (frågorna|svaren):*\s*\n*/im,
        /^\s*Självklart! Här är frågorna:*\s*\n*/im,
        /^\s*Här kommer ditt facit:*\s*\n*/im,
        /^\s*Varsågod, här är frågorna:*\s*\n*/im,
        /^\s*Här är förslagen på instuderingsfrågor:*\s*\n*/im
    ];
    let madeChange = false;
    do {
        madeChange = false;
        for (const regex of commonLeadingPhrases) {
            const tempText = cleanedText.replace(regex, "");
            if (tempText !== cleanedText) {
                cleanedText = tempText;
                madeChange = true; // Om en ändring gjordes, kör loopen igen för att hantera flera matchningar
            }
        }
    } while (madeChange);

    // Om texten efter borttagning av ledande fraser INTE börjar med numrering (t.ex. "1. ")
    // OCH är relativt kort, logga en varning, eftersom det kan tyda på att AI:n inte följde instruktionerna.
    if (!cleanedText.trim().match(/^\s*[0-9]+\./m) && cleanedText.length < 100 && cleanedText.length > 0) {
        if (text.length > cleanedText.length) { // Om vi faktiskt tog bort något
            console.warn(`AI output för ${sourceLabel} efter borttagning av ledande fraser börjar inte med numrering och är kort. Ursprunglig text: "${text.substring(0,100)}...", Rensad: "${cleanedText.substring(0,100)}..."`);
        }
    }
    
    const commonTrailingPhrases = [
        /\n*\s*Hoppas detta hjälper!/im,
        /\n*\s*Säg till om du vill ha något ändrat eller fler frågor\./im,
        /\n*\s*Lycka till!/im,
        /\n*\s*Fråga gärna om du undrar något mer!/im
    ];
    for (const regex of commonTrailingPhrases) {
        cleanedText = cleanedText.replace(regex, "");
    }
    
    return cleanedText.trim();
}

const systemMessageForStudentQuestions = `Du är en AI-assistent som genererar instuderingsfrågor FÖR EN STUDENT.
VIKTIGT: Din output MÅSTE börja direkt med den första numrerade frågan (t.ex. "1. ..."). Inkludera absolut ingen text, förklaring, resonemang, eller introduktion före den första frågan. All output som inte är en del av den numrerade listan med frågor (och eventuella svarsalternativ enligt format) kommer att ignoreras.
Följ alla formateringsinstruktioner EXAKT. Fokusera på den begärda fördelningen av frågetyper.
Generera ENDAST den numrerade listan med frågor. INGA SVAR i detta steg.`;

function buildStrictStudentPrompt(totalTargetQuestions, distributionText, numMcq, numShortAnswer, numDiscussion, srtDataForPrompt) {
    let userPromptStudentParts = [];
    userPromptStudentParts.push(`Här kommer text från en srt-fil. Skapa en lista med exakt ${totalTargetQuestions} innehållsnära, välformulerade instuderingsfrågor som är 100 % baserade på innehållet i hela srt-filen – från början till slut.`);
    userPromptStudentParts.push(`\nVIKTIGT: Innan du börjar formulera frågor, MÅSTE du läsa in, analysera och ta hänsyn till innehållet i HELA .srt-filen. Du får INTE enbart fokusera på början.`);

    userPromptStudentParts.push(`\nALLMÄNNA UTFORMNINGSKRAV (MÅSTE FÖLJAS):`);
    userPromptStudentParts.push(`1.  Fördela frågetyperna EXAKT så här: ${distributionText}.`);
    userPromptStudentParts.push(`2.  Presentera ALLA frågor i en enda numrerad lista (börja med "1. ", "2. ", etc.).`);
    userPromptStudentParts.push(`3.  VARJE fråga, oavsett typ, MÅSTE avslutas med en tidsstämpel inom hakparenteser på SAMMA RAD som frågetexten. Tidsstämpeln ska vara i formatet [mm:ss] (eller [hh:mm:ss] om videon är lång) och ska vara STARTTIDEN från det relevanta textblocket i den bifogade undertexten. INGEN FRÅGA UTAN EN SÅDAN TIDSSTÄMPEL PÅ SAMMA RAD.`);
    userPromptStudentParts.push(`4.  Separera varje komplett fråga (fråga + dess eventuella svarsalternativ) från nästa fråga med TVÅ nya rader (en helt tom rad).`);
    userPromptStudentParts.push(`5.  Din respons FÅR ENDAST innehålla den numrerade listan med frågor. INGA SVAR, ingen introduktionstext före fråga 1, och inga kommentarer eller förklaringar efter sista frågan. Börja direkt med "1. ...".`);

    if (numMcq > 0) {
        userPromptStudentParts.push(`\nSPECIFIKA KRAV FÖR FLERVALSFRÅGOR (MÅSTE FÖLJAS FÖR ALLA ${numMcq} FLERVALSFRÅGOR):`);
        userPromptStudentParts.push(`-   Varje flervalsfråga (som måste ha en tidsstämpel enligt punkt 3 ovan) ska OMEDELBART följas av EXAKT fyra (4) distinkta svarsalternativ på nya rader under frågan.`);
        userPromptStudentParts.push(`-   Märk dessa svarsalternativ A., B., C., D. (eller A) B) C) D)).`);
        userPromptStudentParts.push(`-   Ett av alternativen ska vara det korrekta svaret som kan härledas från undertexten.`);
        userPromptStudentParts.push(`-   De övriga tre alternativen ska vara rimliga men felaktiga. Undvik uppenbart felaktiga eller alltför enkla alternativ.`);
        userPromptStudentParts.push(`-   Ange INTE vilket alternativ som är det korrekta i denna elevversion.`);
    }
    if (numShortAnswer > 0) {
        userPromptStudentParts.push(`\nSPECIFIKA KRAV FÖR KORTSVARSFRÅGOR (MÅSTE FÖLJAS FÖR ALLA ${numShortAnswer} KORTSVARSFRÅGOR):`);
        userPromptStudentParts.push(`-   Frågan ska vara formulerad så att svaret är en kort text baserad på information, resonemang eller uttalanden direkt från undertexten.`);
        userPromptStudentParts.push(`-   Frågan MÅSTE följa de allmänna utformningskraven (numrering, tidsstämpel på samma rad).`);
    }
    if (numDiscussion > 0) {
        userPromptStudentParts.push(`\nSPECIFIKA KRAV FÖR DISKUSSIONSFRÅGA (MÅSTE FÖLJAS FÖR ${numDiscussion} DISKUSSIONSFRÅGA):`);
        userPromptStudentParts.push(`-   Frågan ska inbjuda till reflektion och/eller analys baserat på innehållet i undertexten.`);
        userPromptStudentParts.push(`-   Den kan med fördel referera till eller uppmuntra användning av information från flera olika delar av undertexten.`);
        userPromptStudentParts.push(`-   Frågan MÅSTE följa de allmänna utformningskraven (numrering, tidsstämpel på samma rad).`);
    }

    userPromptStudentParts.push(`\nHär är text från srt-filen (varje block inleds med sitt tidsintervall [starttid] --> [sluttid]):`);
    userPromptStudentParts.push(`--- START AV BANTAD SRT ---`);
    userPromptStudentParts.push(srtDataForPrompt);
    userPromptStudentParts.push(`--- SLUT AV BANTAD SRT ---`);
    userPromptStudentParts.push(`\nKOM IHÅG: Börja din respons direkt med "1. ...". Följ formatkraven noggrant för tidsstämplar och flervalsalternativ.`);

    return userPromptStudentParts.join('\n');
}


// --- NYA ENDPOINTS FÖR ASYNKRON VIDEONEDLADDNING ---

app.post('/initiate-video-download', (req, res) => {
    const { mediaLink } = req.body;
    if (!mediaLink || !isValidUrl(mediaLink)) {
        return res.status(400).json({ error: 'Ogiltig eller saknad media-länk.' });
    }

    const jobId = crypto.randomBytes(8).toString('hex');
    videoDownloadJobs[jobId] = {
        status: 'pending',
        mediaLink,
        filePath: null,
        fileName: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    console.log(`Jobb ${jobId} skapat för ${mediaLink}. Status: pending.`);
    res.status(202).json({ jobId, message: 'Videonedladdning påbörjad.' }); // 202 Accepted

    // Starta själva nedladdningen asynkront
    processVideoDownload(jobId, mediaLink);
});

async function processVideoDownload(jobId, mediaLink) {
    videoDownloadJobs[jobId].status = 'processing';
    videoDownloadJobs[jobId].updatedAt = new Date();
    console.log(`Jobb ${jobId} status: processing. Länk: ${mediaLink}`);

    const uniqueFileId = Date.now(); // För att skapa unika temp-mappar
    const tempDir = os.tmpdir();
    const jobSpecificOutputDir = path.join(tempDir, `video_job_${jobId}_${uniqueFileId}`);

    try {
        await fs.mkdir(jobSpecificOutputDir, { recursive: true });
        console.log(`Jobb ${jobId}: Temporär mapp skapad: ${jobSpecificOutputDir}`);
    } catch (mkdirError) {
        console.error(`Jobb ${jobId}: Kunde inte skapa temporär mapp ${jobSpecificOutputDir}:`, mkdirError);
        videoDownloadJobs[jobId].status = 'failed';
        videoDownloadJobs[jobId].error = 'Serverfel vid förberedelse av nedladdning (mkdir).';
        videoDownloadJobs[jobId].updatedAt = new Date();
        return;
    }

    let downloaderCmd, downloaderArgs;
    let isYoutubeVideo = false;
    const desiredExtension = 'mp4';

    try {
        const parsedUrl = new URL(mediaLink);
        const hostname = parsedUrl.hostname.toLowerCase();
        isYoutubeVideo = hostname.includes('youtube.com') || hostname.includes('youtu.be') || hostname.includes('youtube-nocookie.com') || hostname.includes('youtube.com');
    } catch (e) { 
        console.warn(`Jobb ${jobId}: Kunde inte parsa URL för att bestämma typ: ${mediaLink}`);
    }

    if (isYoutubeVideo) {
        downloaderCmd = '/opt/venv/bin/yt-dlp'; // Absolut sökväg
        downloaderArgs = [
            '--no-warnings', '--no-playlist', mediaLink,
            '-o', path.join(jobSpecificOutputDir, `%(title)s.%(ext)s`),
            '--format', `bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b`, // Stark preferens MP4
            '--merge-output-format', 'mp4',
            '--write-subs', '--write-auto-subs', '--sub-langs', 'sv.*,en.*',
            '--embed-subs', '--verbose'
        ];
        console.log(`Jobb ${jobId}: Använder yt-dlp.`);
    } else { // SVT/UR Play
        downloaderCmd = '/opt/venv/bin/svtplay-dl'; // Absolut sökväg
        downloaderArgs = [
            mediaLink, '--output-format', 'mp4', '-M', '--verbose',
            '-o', jobSpecificOutputDir // svtplay-dl skapar filnamnet i denna mapp
        ];
        console.log(`Jobb ${jobId}: Använder svtplay-dl.`);
    }
    console.log(`Jobb ${jobId}: Fullständigt kommando: ${downloaderCmd} ${downloaderArgs.join(' ')}`);

    try {
        const { stdout, stderr } = await execFilePromise(downloaderCmd, downloaderArgs, { timeout: 7200000 }); // 2 timmars timeout

        // Logga stdout/stderr här också för att se vad som faktiskt hände
        // console.log(`Jobb ${jobId}: ${downloaderCmd} stdout:\n${stdout}`);
        // if (stderr) console.log(`Jobb ${jobId}: ${downloaderCmd} stderr:\n${stderr}`);

        const files = await fs.readdir(jobSpecificOutputDir);
        let videoFile = files.find(f => f.endsWith(`.${desiredExtension}`));
        if (!videoFile) videoFile = files.find(f => f.endsWith('.mkv')); // Fallback till .mkv

        if (!videoFile) {
            console.error(`Jobb ${jobId}: Ingen videofil (.mp4 eller .mkv) hittades i ${jobSpecificOutputDir}. Filer:`, files.join(', '));
            throw new Error('Kunde inte hitta den nedladdade videofilen på servern efter bearbetning.');
        }

        const fullVideoPath = path.join(jobSpecificOutputDir, videoFile);
        console.log(`Jobb ${jobId}: Video nedladdad och bearbetad: ${fullVideoPath}`);

        videoDownloadJobs[jobId].status = 'completed';
        videoDownloadJobs[jobId].filePath = fullVideoPath;
        videoDownloadJobs[jobId].fileName = videoFile; // Spara faktiska filnamnet
        videoDownloadJobs[jobId].updatedAt = new Date();
        console.log(`Jobb ${jobId} status: completed. Fil: ${videoFile}`);

    } catch (execError) {
        console.error(`Jobb ${jobId}: Fel under videonedladdningsprocessen. Kommando: ${downloaderCmd}`);
        console.error(`Jobb ${jobId}: Felmeddelande: ${execError.message}`);
        if(execError.stderr) console.error(`Jobb ${jobId}: Stderr från kommandot: \n${execError.stderr}`);
        if(execError.stdout) console.error(`Jobb ${jobId}: Stdout från kommandot: \n${execError.stdout}`);

        videoDownloadJobs[jobId].status = 'failed';
        videoDownloadJobs[jobId].error = `Fel vid nedladdning/bearbetning: ${execError.message.split('\n')[0]}`; // Ta första raden av felet
        videoDownloadJobs[jobId].updatedAt = new Date();
        console.log(`Jobb ${jobId} status: failed.`);
        
        await fs.rm(jobSpecificOutputDir, { recursive: true, force: true }).catch(e => console.warn(`Jobb ${jobId}: Kunde inte städa upp ${jobSpecificOutputDir} efter fel:`, e));
    }
}

app.get('/video-download-status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = videoDownloadJobs[jobId];

    if (!job) {
        return res.status(404).json({ error: 'Jobb ej hittat.' });
    }
    // console.log(`Statusförfrågan för jobb ${jobId}: Status=${job.status}, Filnamn=${job.fileName || 'N/A'}`);
    res.json({
        jobId,
        status: job.status,
        fileName: job.fileName,
        error: job.error,
        updatedAt: job.updatedAt
    });
});

app.get('/get-downloaded-video/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const job = videoDownloadJobs[jobId];

    if (!job) {
        console.warn(`Jobb ${jobId} ej hittat för nedladdning.`);
        return res.status(404).json({ error: 'Jobb ej hittat.' });
    }

    if (job.status !== 'completed' || !job.filePath || !job.fileName) {
        console.warn(`Jobb ${jobId} ej redo för nedladdning. Status: ${job.status}, Fil: ${job.filePath}`);
        return res.status(400).json({ error: 'Videon är inte redo för nedladdning eller har misslyckats.' });
    }

    if (!fsc.existsSync(job.filePath)) {
        console.error(`Jobb ${jobId}: Filen ${job.filePath} existerar inte trots status completed!`);
        videoDownloadJobs[jobId].status = 'failed'; // Uppdatera statusen
        videoDownloadJobs[jobId].error = 'Den bearbetade filen kunde inte hittas på servern (kan ha städats).';
        videoDownloadJobs[jobId].updatedAt = new Date();
        return res.status(500).json({ error: 'Internt serverfel: Bearbetad fil saknas.' });
    }

    console.log(`Jobb ${jobId}: Påbörjar skickande av fil: ${job.filePath} med namn: ${job.fileName}`);
    res.download(job.filePath, job.fileName, async (downloadError) => {
        const jobSpecificOutputDir = path.dirname(job.filePath); // Mappen som ska städas

        if (downloadError) {
            console.error(`Jobb ${jobId}: Fel vid skickande av fil "${job.fileName}" till klient:`, downloadError);
            // Om det är ECONNABORTED, har klienten troligen avbrutit. Vi städar ändå.
        } else {
            console.log(`Jobb ${jobId}: Fil "${job.fileName}" skickad till klienten.`);
        }
        
        console.log(`Jobb ${jobId}: Försöker städa upp ${jobSpecificOutputDir}`);
        await fs.rm(jobSpecificOutputDir, { recursive: true, force: true }).catch(e => console.warn(`Jobb ${jobId}: Kunde inte städa upp ${jobSpecificOutputDir}:`, e));
        
        // Ta bort jobbet från minnet efter att det har hanterats (nedladdat eller misslyckats skicka)
        delete videoDownloadJobs[jobId];
        console.log(`Jobb ${jobId} borttaget från minnet efter hantering.`);
    });
});

// --- DINA BEFINTLIGA ENDPOINTS ---
app.post('/generate-student-questions', async (req, res) => {
    const { mediaLink, counts } = req.body;
    if (!mediaLink || !isValidUrl(mediaLink)) {
        return res.status(400).json({ error: 'Ogiltig eller saknad media-länk (SVT Play, UR Play eller YouTube).' });
    }
    if (!counts || typeof counts.flerval !== 'number' || typeof counts.kortsvar !== 'number' || typeof counts.diskussion !== 'number') {
        return res.status(400).json({ error: 'Ogiltigt format för antal frågor.' });
    }

    const numMcq = counts.flerval;
    const numShortAnswer = counts.kortsvar;
    const numDiscussion = counts.diskussion;
    const totalTargetQuestions = numMcq + numShortAnswer + numDiscussion;

    if (totalTargetQuestions < 1) {
        return res.status(400).json({ error: 'Ange minst en fråga.' });
    }

    let distributionTextParts = [];
    if (numMcq > 0) distributionTextParts.push(`${numMcq} flervalsfrågor`);
    if (numShortAnswer > 0) distributionTextParts.push(`${numShortAnswer} kortsvarfrågor`);
    if (numDiscussion > 0) {
        distributionTextParts.push(`${numDiscussion} ${numDiscussion === 1 ? 'diskussionsfråga' : 'diskussionsfrågor'}`);
    }

    let distributionText = "inga frågor av specificerade typer";
    if (distributionTextParts.length > 0) {
        if (distributionTextParts.length === 1) {
            distributionText = distributionTextParts[0];
        } else if (distributionTextParts.length === 2) {
            distributionText = distributionTextParts.join(' och ');
        } else {
            const lastPart = distributionTextParts.pop();
            distributionText = distributionTextParts.join(', ') + ', och ' + lastPart;
        }
    }
    console.log(`Begärda frågetypsfördelning för elevfrågor: ${distributionText}`);

    try {
        const rawSrtFileData = await getSrtFile(mediaLink);
        if (!rawSrtFileData || rawSrtFileData.trim() === "") {
            throw new Error("SRT-filen som hämtades/transkriberades är tom eller kunde inte läsas.");
        }

        const parsedSrt = parseAndSlimSrt(rawSrtFileData);
        const srtDataForPrompt = deduplicateSlimmedSrt(parsedSrt);

        if (!srtDataForPrompt || srtDataForPrompt.trim() === "") {
             console.warn("Efter parsning och deduplicering är SRT-datan tom. MediaLink:", mediaLink);
             throw new Error("Undertexten blev tom efter bearbetning. Det finns inget att skapa frågor från.");
        }

        const user_prompt_student = buildStrictStudentPrompt(
            totalTargetQuestions,
            distributionText,
            numMcq,
            numShortAnswer,
            numDiscussion,
            srtDataForPrompt
        );

        const messages1 = [{ role: "system", content: systemMessageForStudentQuestions }, { role: "user", content: user_prompt_student }];
        // Uppskatta output tokens mer generöst
        const estimatedOutputTokens = (totalTargetQuestions * 200) + (numMcq * 200); 
        const maxOutputTokens = Math.max(2800, Math.min(4050, estimatedOutputTokens)); 


        let studentQuestionsText = await callNovitaAI(messages1, 1, 1, "Elevfrågor (med [start]-->[slut] SRT)", maxOutputTokens);

        console.log("\n--- RÅTT SVAR FRÅN AI (Elevfrågor - /generate-student-questions) ---");
        console.log(studentQuestionsText.substring(0, 500) + (studentQuestionsText.length > 500 ? "..." : "")); // Logga bara början
        console.log("--- SLUT PÅ RÅTT SVAR ---\n");

        studentQuestionsText = sanitizeAiGeneratedText(studentQuestionsText, "Elevfrågor (med [start]-->[slut] SRT)");

        if (!studentQuestionsText || studentQuestionsText.trim() === "" || !studentQuestionsText.trim().match(/^\s*1\./m)) {
            console.warn("AI:n genererade ingen valid output för elevfrågor efter sanering, eller så började den inte med '1.'.");
            throw new Error("AI:n genererade inga elevfrågor eller följde inte formatet (tom output eller fel start efter sanering).");
        }
        res.status(200).json({ studentText: studentQuestionsText });

    } catch (err) {
        console.error(`Fel i /generate-student-questions: ${err.message}`, err.stack ? err.stack.substring(0,500) : '');
        const clientErrorMessage = err.message.includes("Novita.ai") || err.message.includes("SRT-fil") || err.message.includes("AI:n genererade inga") || err.message.includes("Kunde inte hämta undertexter") || err.message.includes("Transkribering") || err.message.includes("Undertexten blev tom") ? err.message : `Serverfel under generering av elevfrågor.`;
        res.status(500).json({ error: clientErrorMessage });
    }
});

app.post('/generate-teacher-answers', async (req, res) => {
    const { studentQuestions, mediaLink } = req.body;
    if (!studentQuestions || studentQuestions.trim() === "") {
        return res.status(400).json({ error: "Inga elevfrågor att skapa facit för." });
    }
    if (!mediaLink || !isValidUrl(mediaLink)) {
        return res.status(400).json({ error: 'Ogiltig eller saknad media-länk (SVT Play, UR Play eller YouTube) för facitgenerering.' });
    }

    try {
        const rawSrtFileData = await getSrtFile(mediaLink);
        if (!rawSrtFileData || rawSrtFileData.trim() === "") {
            throw new Error("SRT-filen som hämtades/transkriberades för facit är tom eller kunde inte läsas.");
        }

        const parsedSrtForTeacher = parseAndSlimSrt(rawSrtFileData);
        const srtDataForTeacherPrompt = deduplicateSlimmedSrt(parsedSrtForTeacher);

        if (!srtDataForTeacherPrompt || srtDataForTeacherPrompt.trim() === "") {
             console.warn("Efter parsning och deduplicering för FACIT är SRT-datan tom. MediaLink:", mediaLink);
             throw new Error("Undertexten blev tom efter bearbetning. Det finns inget att skapa facit från.");
        }


        const system_prompt_teacher = `Du är en AI-assistent som lägger till KORREKTA SVAR till en given lista med instuderingsfrågor.
VIKTIGT: Din output MÅSTE börja direkt med den första numrerade frågan (t.ex. "1. ...") från elevversionen, följt av dess svar. Inkludera absolut ingen text, förklaring, resonemang, eller introduktion före den första frågan. All output som inte är en del av den numrerade listan med frågor och svar enligt format kommer att ignoreras.
Använd den ursprungliga undertexten (i dess bantade format) som enda referens för att formulera svaren. Följ de specifika formateringsinstruktionerna för svar till varje frågetyp.
Generera ENDAST den kompletta lärarversionen (frågor MED svar).`;

        const user_prompt_teacher = `Här är en lista med instuderingsfrågor (elevversion) och den ursprungliga undertexten (formaterad med tidsintervall [starttid] --> [sluttid] per textblock) de baserades på.
Din uppgift är att skapa en LÄRARVERSION genom att lägga till svar till VARJE fråga.
Använd ENDAST den ursprungliga undertexten (i dess förenklade format) för att härleda korrekta och relevanta svar.
Behåll exakt samma frågor, numrering, och tidsstämplar [mm:ss] (eller [hh:mm:ss]) som i den givna elevversionen.

INSTRUKTIONER FÖR SVARFORMAT I LÄRARVERSIONEN:
1.  För flervalsfrågor (de som har A,B,C,D alternativ i elevversionen):
    Upprepa frågan och dess alternativ från elevversionen.
    Identifiera det korrekta alternativet. Skriv på en ny rad direkt under alternativen:
    Rätt svar: Bokstav. Hela texten för det korrekta svarsalternativet (t.ex. "Rätt svar: B. Alternativets text")
2.  För kortsvarfrågor (de som INTE har A,B,C,D alternativ i elevversionen):
    Upprepa frågan från elevversionen.
    Skriv på en ny rad direkt under frågan:
    Svar: Kort och koncis svarstext baserad på undertexten.
3.  För diskussionsfrågor (de som INTE har A,B,C,D alternativ och är mer öppna):
    Upprepa frågan från elevversionen.
    Skriv på en ny rad direkt under frågan:
    Förslag på svar: Utvecklad svarstext eller diskussionspunkter baserade på undertexten. Använd gärna flera meningar.

ALLMÄNT FORMAT FÖR LÄRARVERSIONEN:
-   Börja direkt med fråga 1 (från elevversionen), dess eventuella alternativ, och sedan dess svar.
-   Separera varje komplett fråga (fråga + [alternativ] + svar) från nästa fråga med TVÅ nya rader (en helt tom rad).
-   VIKTIGT: Generera INGA extra rubriker, INGA "DEL X", eller liknande.

Ursprunglig undertext (formaterad med tidsintervall [starttid] --> [sluttid] per textblock):
--- START AV BANTAD SRT ---
${srtDataForTeacherPrompt} 
--- SLUT AV BANTAD SRT ---

Elevversion att komplettera med svar:
--- ELEVVERSION START ---
${studentQuestions}
--- ELEVVERSION SLUT ---

PÅMINNELSE: Generera ENBART den numrerade listan med frågor och svar enligt ovanstående format. Börja direkt med '1. ...'. Ingen extra text är tillåten.`;

        const messages2 = [{ role: "system", content: system_prompt_teacher }, { role: "user", content: user_prompt_teacher }];
        // Generösare uppskattning för facit
        const estimatedOutputTokensTeacher = studentQuestions.length * 3.5; 
        const maxOutputTokensTeacher = Math.max(3500, Math.min(4050, Math.ceil(estimatedOutputTokensTeacher)));

        let teacherVersionWithAnswers = await callNovitaAI(messages2, 0.2, 1, "Lärarsvar (med [start]-->[slut] SRT)", maxOutputTokensTeacher);
        teacherVersionWithAnswers = sanitizeAiGeneratedText(teacherVersionWithAnswers, "Lärarsvar (med [start]-->[slut] SRT)");

        if (!teacherVersionWithAnswers || teacherVersionWithAnswers.trim() === "" || !teacherVersionWithAnswers.trim().match(/^\s*1\./m)) {
            console.warn("AI:n genererade ingen valid output för lärarsvar efter sanering, eller så började den inte med '1.'.");
            throw new Error("AI:n genererade inget facit eller följde inte formatet (tom output eller fel start efter sanering).");
        }
        res.status(200).json({ teacherText: teacherVersionWithAnswers });

    } catch (err) {
        console.error(`Fel i /generate-teacher-answers: ${err.message}`, err.stack ? err.stack.substring(0,500) : '');
        const clientErrorMessage = err.message.includes("Novita.ai") || err.message.includes("SRT-fil") || err.message.includes("AI:n genererade inget") || err.message.includes("Kunde inte hämta undertexter") || err.message.includes("Transkribering") || err.message.includes("Undertexten blev tom") ? err.message : `Serverfel under generering av facit.`;
        res.status(500).json({ error: clientErrorMessage });
    }
});

app.post('/generate-ai-prompt', async (req, res) => {
    const { mediaLink, counts } = req.body;
    if (!mediaLink || !isValidUrl(mediaLink)) {
        return res.status(400).json({ error: 'Ogiltig eller saknad media-länk (SVT Play, UR Play eller YouTube).' });
    }
    if (!counts || typeof counts.flerval !== 'number' || typeof counts.kortsvar !== 'number' || typeof counts.diskussion !== 'number') {
        return res.status(400).json({ error: 'Ogiltigt format för antal frågor.' });
    }

    const numMcq = counts.flerval;
    const numShortAnswer = counts.kortsvar;
    const numDiscussion = counts.diskussion;
    const totalTargetQuestions = numMcq + numShortAnswer + numDiscussion;

    if (totalTargetQuestions < 1) {
        return res.status(400).json({ error: 'Ange minst en fråga för att generera en meningsfull prompt.' });
    }

    try {
        const rawSrtFileData = await getSrtFile(mediaLink);
        if (!rawSrtFileData || rawSrtFileData.trim() === "") {
            throw new Error("SRT-filen som hämtades/transkriberades för promptgenerering är tom eller kunde inte läsas.");
        }

        const parsedSrt = parseAndSlimSrt(rawSrtFileData);
        const srtDataForPrompt = deduplicateSlimmedSrt(parsedSrt);
        
        if (!srtDataForPrompt || srtDataForPrompt.trim() === "") {
             console.warn("Efter parsning och deduplicering för PROMPT är SRT-datan tom. MediaLink:", mediaLink);
             throw new Error("Undertexten blev tom efter bearbetning. Det finns inget att skapa prompt från.");
        }


        let distributionTextParts = [];
        if (numMcq > 0) distributionTextParts.push(`${numMcq} flervalsfrågor`);
        if (numShortAnswer > 0) distributionTextParts.push(`${numShortAnswer} kortsvarfrågor`);
        if (numDiscussion > 0) {
            distributionTextParts.push(`${numDiscussion} ${numDiscussion === 1 ? 'diskussionsfråga' : 'diskussionsfrågor'}`);
        }

        let distributionText = "inga frågor av specificerade typer";
        if (distributionTextParts.length > 0) {
            if (distributionTextParts.length === 1) {
                distributionText = distributionTextParts[0];
            } else if (distributionTextParts.length === 2) {
                distributionText = distributionTextParts.join(' och ');
            } else {
                const lastPart = distributionTextParts.pop();
                distributionText = distributionTextParts.join(', ') + ', och ' + lastPart;
            }
        }

        const userPromptContent = buildStrictStudentPrompt(
            totalTargetQuestions,
            distributionText,
            numMcq,
            numShortAnswer,
            numDiscussion,
            srtDataForPrompt
        );

        const promptForUserDisplay = `${systemMessageForStudentQuestions}\n\n---- ANVÄNDARPROMPT (börjar nedan) ----\n\n${userPromptContent}`;

        res.status(200).json({ promptText: promptForUserDisplay });

    } catch (err) {
        console.error(`Fel i /generate-ai-prompt: ${err.message}`, err.stack ? err.stack.substring(0,500) : '');
        const clientErrorMessage = err.message.includes("SRT-fil") || err.message.includes("Kunde inte hämta undertexter") || err.message.includes("Transkribering") || err.message.includes("Undertexten blev tom") ? err.message : `Serverfel vid generering av AI-prompt.`;
        res.status(500).json({ error: clientErrorMessage });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Servern körs på http://localhost:${PORT}`));
