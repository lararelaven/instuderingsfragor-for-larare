// Ladda miljövariabler från .env-filen
const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const { exec, execFile } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

const NOVITA_API_KEY = process.env.NOVITA_API_KEY;
const NOVITA_API_ENDPOINT = process.env.NOVITA_API_ENDPOINT;
const NOVITA_MODEL_NAME = process.env.NOVITA_MODEL_NAME;

const NOVITA_STT_API_ENDPOINT = process.env.NOVITA_STT_API_ENDPOINT;
const NOVITA_WHISPER_MODEL_NAME = process.env.NOVITA_WHISPER_MODEL_NAME;

if (!NOVITA_API_KEY || !NOVITA_API_ENDPOINT || !NOVITA_MODEL_NAME) {
    console.error("VARNING: Novita.ai API-konfiguration (LLM) är inte fullständigt satt i .env-filen.");
}

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// --- HJÄLPFUNKTIONER ---
// (isValidUrl, execFilePromise, callNovitaSttApi, getSrtFile, 
//  parseAndSlimSrt, deduplicateSlimmedSrt, callNovitaAI, 
//  sanitizeAiGeneratedText, systemMessageForStudentQuestions, buildStrictStudentPrompt
//  ska finnas här - se tidigare svar för deras fullständiga definitioner)

function isValidUrl(url) {
    if (!url || typeof url !== 'string' || url.trim() === '') return false;
    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();
        return hostname.includes('svtplay.se') ||
            hostname.includes('urplay.se') ||
            hostname.includes('youtube.com') ||
            hostname.includes('youtu.be');
    } catch (e) {
        return false;
    }
}

const execFilePromise = (command, args, options) => {
    return new Promise((resolveExec) => {
        execFile(command, args, options, (error, stdout, stderr) => {
            if (stdout) console.log(`${command} stdout:\n${stdout}`);
            if (stderr &&
                !stderr.toLowerCase().includes("ignoring unsupported parameter") &&
                !stderr.toLowerCase().includes("default srt subtitles not found") &&
                !stderr.toLowerCase().includes("automatic subtitles not found")) {
                console.warn(`${command} stderr:\n${stderr}`);
            }
            resolveExec({ error, stdout, stderr });
        });
    });
};

async function callNovitaSttApi(audioFilePath, language = 'sv') {
    const effectiveSttEndpoint = NOVITA_STT_API_ENDPOINT || 'https://api.novita.ai/v2/stt';
    const effectiveWhisperModel = NOVITA_WHISPER_MODEL_NAME || 'whisper-large-v3';

    if (!NOVITA_API_KEY) {
        throw new Error("Novita.ai API-nyckel (NOVITA_API_KEY) är inte satt i .env-filen.");
    }
    if (!require('fs').existsSync(audioFilePath)) {
        throw new Error(`Ljudfilen kunde inte hittas: ${audioFilePath}`);
    }
    if (!NOVITA_STT_API_ENDPOINT) {
        console.warn("NOVITA_STT_API_ENDPOINT är inte konfigurerad i .env. STT-anrop kommer sannolikt att misslyckas.");
        throw new Error("NOVITA_STT_API_ENDPOINT är inte konfigurerad.");
    }

    console.log(`Anropar Novita.ai STT API (${effectiveSttEndpoint}) för fil: ${audioFilePath} med modell ${effectiveWhisperModel}`);

    const formData = new FormData();
    formData.append('file', require('fs').createReadStream(audioFilePath));
    formData.append('model_name', effectiveWhisperModel);
    formData.append('language', language);
    formData.append('response_format', 'srt');

    try {
        const response = await axios.post(effectiveSttEndpoint, formData, {
            headers: {
                ...formData.getHeaders(),
                'Authorization': `Bearer ${NOVITA_API_KEY}`,
            },
            timeout: 1800000,
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
                        const MAX_LINE_LENGTH = 42;
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
    // ... (befintlig funktion) ...
    if (!isValidUrl(mediaLink)) {
        throw new Error('Ogiltig eller ej stödd media-länk i getSrtFile.');
    }

    const parsedUrl = new URL(mediaLink);
    const hostname = parsedUrl.hostname.toLowerCase();
    const isYoutube = hostname.includes('youtube.com') || hostname.includes('youtu.be');

    const uniqueFileId = Date.now();
    const uniqueFileNameBaseNoExt = path.join(os.tmpdir(), `media_temp_${uniqueFileId}`);

    let srtDownloaderCommand;
    let srtDownloaderArgs;

    if (isYoutube) {
        srtDownloaderCommand = 'yt-dlp';
        srtDownloaderArgs = [
            '--no-warnings',
            '--write-sub', '--write-auto-sub',
            '--convert-subs', 'srt',
            '--sub-langs', 'sv.*,en.*',
            '--sub-format', 'srt/vtt/best',
            '--skip-download',
            '-o', `${uniqueFileNameBaseNoExt}.%(ext)s`,
            mediaLink
        ];
    } else {
        srtDownloaderCommand = 'svtplay-dl';
        srtDownloaderArgs = [
            '-S', '--force-subtitle',
            '-o', uniqueFileNameBaseNoExt,
            mediaLink
        ];
    }

    console.log(`Försöker hämta undertexter med: ${srtDownloaderCommand} ${srtDownloaderArgs.join(' ')}`);

    await execFilePromise(srtDownloaderCommand, srtDownloaderArgs, { timeout: 120000 });

    const tempDir = os.tmpdir();
    let filesInTemp = await fs.readdir(tempDir);
    const downloadedSrtFile = filesInTemp.find(f =>
        f.startsWith(path.basename(uniqueFileNameBaseNoExt)) && f.endsWith('.srt')
    );

    if (downloadedSrtFile) {
        const finalSrtPath = path.join(tempDir, downloadedSrtFile);
        console.log(`Hittade nedladdad SRT-fil: ${finalSrtPath}`);
        try {
            const srtFileData = await fs.readFile(finalSrtPath, 'utf-8');
            await fs.unlink(finalSrtPath).catch(e => console.warn(`Kunde inte radera temporär SRT-fil: ${finalSrtPath}`, e));
            if (srtFileData && srtFileData.trim() !== '') {
                console.log("Undertexter hämtade direkt.");
                return srtFileData;
            }
            console.log("Nedladdad SRT-fil var tom.");
        } catch (fileError) {
            console.warn(`Fel vid läsning/radering av nedladdad SRT-fil: ${fileError.message}. Fortsätter för ev. transkribering.`);
        }
    }

    if (isYoutube && NOVITA_STT_API_ENDPOINT && NOVITA_API_KEY) {
        console.log("Inga befintliga undertexter hittades eller filen var tom för YouTube-länk. Försöker transkribera ljud via Novita.ai STT...");

        const audioFileBase = `${uniqueFileNameBaseNoExt}_audio`;

        const audioDlCommand = 'yt-dlp';
        const audioDlArgs = [
            '--no-warnings', '-x', '-f', 'bestaudio',
            '--audio-format', 'wav',
            '-o', `${audioFileBase}.%(ext)s`,
            mediaLink
        ];

        console.log(`Laddar ner ljud: ${audioDlCommand} ${audioDlArgs.join(' ')}`);
        const { error: audioErrorDl } = await execFilePromise(audioDlCommand, audioDlArgs, { timeout: 300000 });

        filesInTemp = await fs.readdir(tempDir);
        const actualAudioFile = filesInTemp.find(f => f.startsWith(path.basename(audioFileBase)) && (f.endsWith('.wav') || f.endsWith('.mp3') || f.endsWith('.m4a')));

        if (!actualAudioFile) {
            let errorMsg = `Ljudfil ${audioFileBase}.* kunde inte hittas efter nedladdningsförsök.`;
            if (audioErrorDl) errorMsg += ` Nedladdningsfel: ${audioErrorDl.message}`;
            console.error(errorMsg);
            const otherFiles = filesInTemp.filter(f => f.startsWith(path.basename(audioFileBase)));
            for (const f of otherFiles) { await fs.unlink(path.join(tempDir, f)).catch(() => { }); }
            throw new Error(errorMsg);
        }
        const audioFilePath = path.join(tempDir, actualAudioFile);

        console.log(`Ljudfil nedladdad till: ${audioFilePath}. Startar transkribering via Novita.ai STT API...`);
        try {
            const transcribedSrtData = await callNovitaSttApi(audioFilePath, 'sv');
            await fs.unlink(audioFilePath).catch(e => console.warn(`Kunde inte radera ljudfil: ${audioFilePath}`, e));
            console.log("Transkribering via Novita.ai STT lyckades.");
            return transcribedSrtData;
        } catch (sttError) {
            await fs.unlink(audioFilePath).catch(e => console.warn(`Kunde inte radera ljudfil (efter STT-fel): ${audioFilePath}`, e));
            console.error(`Fel vid transkribering via Novita.ai STT: ${sttError.message}`);
            throw new Error(`Transkribering via Novita.ai STT misslyckades: ${sttError.message}`);
        }
    } else if (isYoutube) {
        console.log("Inga undertexter för YouTube, och Novita STT API är inte konfigurerat (NOVITA_STT_API_ENDPOINT och/eller NOVITA_API_KEY saknas i .env). Kan inte transkribera.");
        throw new Error('Inga undertexter hittades och STT-tjänsten är inte (fullständigt) konfigurerad.');
    }
    else {
        console.log("Inga undertexter hittades (och inte YouTube för STT-försök).");
        throw new Error('Inga undertexter kunde hittas eller genereras för denna media.');
    }
}

function parseAndSlimSrt(srtData) {
    // ... (befintlig funktion)
    let srtContentToParse = srtData.replace(/\r\n/g, '\n');
    if (srtContentToParse.charCodeAt(0) === 0xFEFF) {
        srtContentToParse = srtContentToParse.substring(1);
    }

    const blocks = srtContentToParse.split(/\n\n+/);
    let slimmedSrt = "";
    for (const block of blocks) {
        if (block.trim() === "") continue;
        const lines = block.trim().split('\n');
        let timeLineIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('-->')) {
                timeLineIndex = i;
                break;
            }
        }
        if (timeLineIndex === -1) {
            if (blocks.length === 1 && lines.length > 0 && lines[0].trim() !== "") {
                const textContent = lines.join('\n').trim();
                if (textContent) {
                    console.warn("SRT-block saknar tidsstämpel, använder dummy-tid för hela blocket:", block.substring(0, 100));
                    slimmedSrt += `[00:00] --> [00:00]\n${textContent}\n\n`;
                }
            } else {
                console.warn("SRT-block saknar '-->' tidslinje:", lines.join(' | ').substring(0, 100));
            }
            continue;
        }

        const timeMatch = lines[timeLineIndex].match(/(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})/);
        let shortTimeMatch = null;
        if (!timeMatch) {
            shortTimeMatch = lines[timeLineIndex].match(/(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2})[,.](\d{3})/);
        }

        if (timeMatch || shortTimeMatch) {
            let startHour = "00", startMinute, startSecond, endHour = "00", endMinute, endSecond;
            if (timeMatch) {
                startHour = timeMatch[1];
                startMinute = timeMatch[2];
                startSecond = timeMatch[3];
                endHour = timeMatch[5];
                endMinute = timeMatch[6];
                endSecond = timeMatch[7];
            } else {
                startMinute = shortTimeMatch[1];
                startSecond = shortTimeMatch[2];
                endMinute = shortTimeMatch[4];
                endSecond = shortTimeMatch[5];
            }

            let formattedStartTime;
            if (startHour === "00" || parseInt(startHour, 10) === 0) {
                formattedStartTime = `${String(startMinute).padStart(2, '0')}:${String(startSecond).padStart(2, '0')}`;
            } else {
                formattedStartTime = `${String(startHour).padStart(2, '0')}:${String(startMinute).padStart(2, '0')}:${String(startSecond).padStart(2, '0')}`;
            }

            let formattedEndTime;
            if (endHour === "00" || parseInt(endHour, 10) === 0) {
                formattedEndTime = `${String(endMinute).padStart(2, '0')}:${String(endSecond).padStart(2, '0')}`;
            } else {
                formattedEndTime = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:${String(endSecond).padStart(2, '0')}`;
            }

            const textContent = lines.slice(timeLineIndex + 1).join('\n').trim();
            if (textContent) {
                slimmedSrt += `[${formattedStartTime}] --> [${formattedEndTime}]\n${textContent}\n\n`;
            }
        } else {
            console.warn("Okänt tidsformat i SRT-block efter försök att parsa:", lines[timeLineIndex]);
        }
    }
    return slimmedSrt.trim();
}

function deduplicateSlimmedSrt(slimmedSrtString) {
    // ... (befintlig funktion)
    if (!slimmedSrtString || slimmedSrtString.trim() === "") {
        return "";
    }
    const entries = [];
    const rawBlocks = slimmedSrtString.trim().split(/\n\n+/);

    for (const block of rawBlocks) {
        const lines = block.split('\n');
        if (lines.length < 2 || !lines[0].includes("-->")) {
            console.warn("Deduplicate: Hoppar över block utan valid tidsrad:", block.substring(0, 50));
            continue;
        }
        entries.push({ timeLine: lines[0], originalText: lines.slice(1).join('\n').trim() });
    }

    if (entries.length === 0) {
        return "";
    }

    const cleanedEntries = [];
    let textOfLastContributingEntry = "";

    for (let i = 0; i < entries.length; i++) {
        const currentOriginalText = entries[i].originalText;
        let textToProcess = currentOriginalText;

        if (cleanedEntries.length > 0) {
            const lastCleanedEntryText = cleanedEntries[cleanedEntries.length - 1].text;

            if (currentOriginalText === textOfLastContributingEntry) {
                if (lastCleanedEntryText === currentOriginalText || currentOriginalText.endsWith(lastCleanedEntryText)) {
                    cleanedEntries[cleanedEntries.length - 1].timeLine = entries[i].timeLine;
                }
                continue;
            }

            if (textOfLastContributingEntry && currentOriginalText.startsWith(textOfLastContributingEntry)) {
                let newAppendedText = currentOriginalText.substring(textOfLastContributingEntry.length).trim();

                if (newAppendedText === "") {
                    if (lastCleanedEntryText === textOfLastContributingEntry) {
                        cleanedEntries[cleanedEntries.length - 1].timeLine = entries[i].timeLine;
                    }
                    textOfLastContributingEntry = currentOriginalText;
                    continue;
                }
                textToProcess = newAppendedText;
            }

            if (textToProcess === lastCleanedEntryText) {
                cleanedEntries[cleanedEntries.length - 1].timeLine = entries[i].timeLine;
                textOfLastContributingEntry = currentOriginalText;
                continue;
            }
        }

        if (textToProcess.trim() === "") {
            textOfLastContributingEntry = currentOriginalText;
            continue;
        }

        cleanedEntries.push({ timeLine: entries[i].timeLine, text: textToProcess });
        textOfLastContributingEntry = currentOriginalText;
    }

    const finalUniqueEntries = [];
    const seenTexts = new Set();
    for (let i = cleanedEntries.length - 1; i >= 0; i--) {
        if (cleanedEntries[i].text.trim() === "") continue;
        if (!seenTexts.has(cleanedEntries[i].text)) {
            finalUniqueEntries.unshift(cleanedEntries[i]);
            seenTexts.add(cleanedEntries[i].text);
        }
    }

    return finalUniqueEntries.map(entry => `${entry.timeLine}\n${entry.text}`).join('\n\n');
}

async function callNovitaAI(messages, temperature, top_p, requestSourceLabel, max_tokens = 4050) {
    // ... (befintlig funktion)
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
            timeout: 180000
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
        if (error.code === 'ECONNABORTED') {
            throw new Error(`Novita.ai LLM API-fel: Timeout vid anrop (${error.message}). Försök igen senare eller justera timeout-inställningen.`);
        }
        const errorDetail = error.response && error.response.data ? (error.response.data.message || error.response.data.detail || JSON.stringify(error.response.data)) : error.message;
        throw new Error(`Novita.ai LLM API-fel: ${errorDetail}`);
    }
}

function sanitizeAiGeneratedText(text, sourceLabel = "Okänd") {
    // ... (befintlig funktion)
    if (typeof text !== 'string') {
        console.warn(`sanitizeAiGeneratedText: input var inte en sträng för ${sourceLabel}. Returnerar tom sträng.`);
        return "";
    }
    let cleanedText = text;
    const commonLeadingPhrases = [
        /^\s*Här är (de begärda|dina) frågorna baserat på undertexten:*\s*\n*/im,
        /^\s*Här är (de begärda|dina) instuderingsfrågorna:*\s*\n*/im,
        /^\s*Här är (ett förslag på|dina) (elevfrågor|lärarsvar|facit):*\s*\n*/im,
        /^\s*Baserat på den givna undertexten, här är (frågorna|svaren):*\s*\n*/im,
        /^\s*Okej, här kommer (frågorna|svaren):*\s*\n*/im,
        /^\s*Visst, här är (frågorna|svaren):*\s*\n*/im,
    ];
    let madeChange = false;
    do {
        madeChange = false;
        for (const regex of commonLeadingPhrases) {
            const tempText = cleanedText.replace(regex, "");
            if (tempText !== cleanedText) {
                cleanedText = tempText;
                madeChange = true;
            }
        }
    } while (madeChange);
    if (!cleanedText.trim().match(/^\s*[0-9]+\./m) && cleanedText.length < 100 && cleanedText.length > 0) {
        if (text.length > cleanedText.length) {
            console.warn(`AI output för ${sourceLabel} efter borttagning av ledande fraser börjar inte med numrering och är kort. Ursprunglig text: "${text.substring(0, 100)}...", Rensad: "${cleanedText.substring(0, 100)}..."`);
        }
    }
    const commonTrailingPhrases = [
        /\n*\s*Hoppas detta hjälper!/im,
        /\n*\s*Säg till om du vill ha något ändrat eller fler frågor\./im,
        /\n*\s*Lycka till!/im,
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
    // ... (befintlig funktion, se till att beskrivningen av SRT-formatet är korrekt:
    //      `Här är text från srt-filen (varje block inleds med sitt tidsintervall [starttid] --> [sluttid]):`
    // )
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

// --- ENDPOINT FÖR VIDEO NEDLADDNING ---
app.post('/download-video', async (req, res) => {
    const { mediaLink } = req.body;
    if (!mediaLink || !isValidUrl(mediaLink)) {
        return res.status(400).json({ error: 'Ogiltig eller saknad media-länk.' });
    }

    const uniqueFileId = Date.now();
    const tempDir = os.tmpdir();
    const outputDir = path.join(tempDir, `video_download_${uniqueFileId}`);

    try {
        await fs.mkdir(outputDir, { recursive: true });
    } catch (mkdirError) {
        console.error("Kunde inte skapa temporär mapp för nedladdning:", mkdirError);
        return res.status(500).json({ error: 'Serverfel vid förberedelse av nedladdning (mkdir).' });
    }

    let downloaderCmd, downloaderArgs;
    let isYoutubeVideo = false;
    const desiredExtension = 'mp4'; // Fokusera på MP4

    try {
        const parsedUrl = new URL(mediaLink);
        const hostname = parsedUrl.hostname.toLowerCase();
        isYoutubeVideo = hostname.includes('youtube.com') || hostname.includes('youtu.be');
    } catch (e) { /* Ignorera */ }

    if (isYoutubeVideo) {
        downloaderCmd = 'yt-dlp';
        downloaderArgs = [
            '--no-warnings',
            '--no-playlist',
            mediaLink,
            '-o', path.join(outputDir, `%(title)s.%(ext)s`),
            '--format', `bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b`, // Stark preferens för MP4
            '--merge-output-format', 'mp4',
            '--write-subs',
            '--write-auto-subs',
            '--sub-langs', 'sv.*,en.*',
            '--embed-subs', // Försök bädda in undertexter
        ];
        console.log("Använder yt-dlp för YouTube-video (siktar på MP4 med inbäddade undertexter).");
    } else { // SVT Play eller UR Play
        downloaderCmd = 'svtplay-dl';
        downloaderArgs = [
            mediaLink,
            '--output-format', 'mp4',
            '-M', // Försök att muxa in standardundertext (oftast svenska)
            '-o', outputDir
        ];
        console.log("Använder svtplay-dl för SVT/UR Play med kommando: svtplay-dl --output-format mp4 -M [länk]");
    }
    console.log(`Fullständigt kommando för videonedladdning: ${downloaderCmd} ${downloaderArgs.join(' ')}`);

    try {
        const { error, stdout, stderr } = await execFilePromise(downloaderCmd, downloaderArgs, { timeout: 3600000 });

        if (error) {
            console.error(`Fel från ${downloaderCmd} under nedladdning:`, error, "\nStderr:", stderr, "\nStdout:", stdout);
            await fs.rm(outputDir, { recursive: true, force: true }).catch(e => console.warn("Kunde inte städa outputDir efter nedladdningsfel:", e));
            return res.status(500).json({ error: `Fel vid nedladdning av video: ${stderr || stdout || error.message}` });
        }

        const files = await fs.readdir(outputDir);
        let videoFile = files.find(f => f.endsWith(`.${desiredExtension}`));

        if (!videoFile) {
            // Fallback om mp4 inte skapades men mkv gjorde det (t.ex. om yt-dlp valde mkv pga undertexter)
            videoFile = files.find(f => f.endsWith('.mkv'));
            if (videoFile) {
                console.warn(`MP4 kunde inte skapas, använder istället hittad MKV-fil: ${videoFile}`);
            } else {
                console.error(`Ingen videofil (.mp4 eller .mkv) hittades i outputDir efter nedladdning. Filer:`, files);
                await fs.rm(outputDir, { recursive: true, force: true }).catch(e => console.warn("Kunde inte städa outputDir, ingen videofil:", e));
                return res.status(500).json({ error: 'Kunde inte hitta den nedladdade videofilen på servern.' });
            }
        }

        const fullVideoPath = path.join(outputDir, videoFile);
        console.log(`Video nedladdad till servern: ${fullVideoPath}. Skickar till klient som "${videoFile}"...`);

        res.download(fullVideoPath, videoFile, async (downloadError) => {
            if (downloadError) {
                console.error(`Fel vid skickande av fil "${videoFile}" till klient:`, downloadError);
            } else {
                console.log(`Fil "${videoFile}" skickad till klienten.`);
            }
            console.log(`Försöker städa upp ${outputDir}`);
            await fs.rm(outputDir, { recursive: true, force: true }).catch(e => console.warn(`Kunde inte städa upp ${outputDir}:`, e));
        });

    } catch (execError) {
        console.error("Allvarligt fel under videonedladdningsprocessen:", execError);
        await fs.rm(outputDir, { recursive: true, force: true }).catch(e => console.warn("Kunde inte städa outputDir efter allvarligt fel:", e));
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internt serverfel vid videonedladdning.' });
        }
    }
});


// --- ÖVRIGA ENDPOINTS ---
app.post('/generate-student-questions', async (req, res) => {
    // ... (befintlig kod, se till att srtDataForPrompt = deduplicateSlimmedSrt(parsedSrt);)
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

        const user_prompt_student = buildStrictStudentPrompt(
            totalTargetQuestions,
            distributionText,
            numMcq,
            numShortAnswer,
            numDiscussion,
            srtDataForPrompt
        );

        const messages1 = [{ role: "system", content: systemMessageForStudentQuestions }, { role: "user", content: user_prompt_student }];
        const estimatedOutputTokens = (totalTargetQuestions * 150) + (numMcq * 150);
        const maxOutputTokens = Math.max(2500, Math.min(4050, estimatedOutputTokens));

        let studentQuestionsText = await callNovitaAI(messages1, 1, 1, "Elevfrågor (med [start]-->[slut] SRT)", maxOutputTokens);

        console.log("\n--- RÅTT SVAR FRÅN AI (Elevfrågor - /generate-student-questions) ---");
        console.log(studentQuestionsText);
        console.log("--- SLUT PÅ RÅTT SVAR ---\n");

        studentQuestionsText = sanitizeAiGeneratedText(studentQuestionsText, "Elevfrågor (med [start]-->[slut] SRT)");

        if (!studentQuestionsText || studentQuestionsText.trim() === "" || !studentQuestionsText.trim().match(/^\s*1\./m)) {
            console.warn("AI:n genererade ingen valid output för elevfrågor efter sanering, eller så började den inte med '1.'.");
            throw new Error("AI:n genererade inga elevfrågor eller följde inte formatet (tom output eller fel start efter sanering).");
        }
        res.status(200).json({ studentText: studentQuestionsText });

    } catch (err) {
        console.error(`Fel i /generate-student-questions: ${err.message}`, err.stack);
        const clientErrorMessage = err.message.includes("Novita.ai") || err.message.includes("SRT-fil") || err.message.includes("AI:n genererade inga") || err.message.includes("Kunde inte hämta undertexter") || err.message.includes("Transkribering") ? err.message : `Serverfel under generering av elevfrågor.`;
        res.status(500).json({ error: clientErrorMessage });
    }
});

app.post('/generate-teacher-answers', async (req, res) => {
    // ... (befintlig kod, se till att srtDataForTeacherPrompt = deduplicateSlimmedSrt(parsedSrtForTeacher);)
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
        const estimatedOutputTokensTeacher = studentQuestions.length * 3;
        const maxOutputTokensTeacher = Math.max(3000, Math.min(4050, Math.ceil(estimatedOutputTokensTeacher)));

        let teacherVersionWithAnswers = await callNovitaAI(messages2, 0.2, 1, "Lärarsvar (med [start]-->[slut] SRT)", maxOutputTokensTeacher);
        teacherVersionWithAnswers = sanitizeAiGeneratedText(teacherVersionWithAnswers, "Lärarsvar (med [start]-->[slut] SRT)");

        if (!teacherVersionWithAnswers || teacherVersionWithAnswers.trim() === "" || !teacherVersionWithAnswers.trim().match(/^\s*1\./m)) {
            console.warn("AI:n genererade ingen valid output för lärarsvar efter sanering, eller så började den inte med '1.'.");
            throw new Error("AI:n genererade inget facit eller följde inte formatet (tom output eller fel start efter sanering).");
        }
        res.status(200).json({ teacherText: teacherVersionWithAnswers });

    } catch (err) {
        console.error(`Fel i /generate-teacher-answers: ${err.message}`, err.stack);
        const clientErrorMessage = err.message.includes("Novita.ai") || err.message.includes("SRT-fil") || err.message.includes("AI:n genererade inget") || err.message.includes("Kunde inte hämta undertexter") || err.message.includes("Transkribering") ? err.message : `Serverfel under generering av facit.`;
        res.status(500).json({ error: clientErrorMessage });
    }
});

app.post('/generate-ai-prompt', async (req, res) => {
    // ... (befintlig kod, se till att srtDataForPrompt = deduplicateSlimmedSrt(parsedSrt);)
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
        console.error(`Fel i /generate-ai-prompt: ${err.message}`, err.stack);
        const clientErrorMessage = err.message.includes("SRT-fil") || err.message.includes("Kunde inte hämta undertexter") || err.message.includes("Transkribering") ? err.message : `Serverfel vid generering av AI-prompt.`;
        res.status(500).json({ error: clientErrorMessage });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log(`Servern körs på http://localhost:${PORT}`));