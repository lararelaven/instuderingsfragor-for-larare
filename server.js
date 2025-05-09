// Ladda miljövariabler från.env-filen
require('dotenv').config();

const express = require('express');
const { exec } = require('child_process');
const fs = require('fs').promises; // Använd promise-versionen av fs
const path = require('path');
const os = require('os'); // För att hitta temporär katalog
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Konfigurera OpenAI-klienten
let openai;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
    });
} else {
    console.error("VARNING: OPENAI_API_KEY är inte satt i.env-filen. Frågegenerering kommer inte att fungera.");
}

app.use(express.json()); // Middleware för att tolka JSON-kroppar från klienten
app.use(express.static(path.join(__dirname))); // Servera statiska filer (index.html, script.js, styles.css)

// Valideringsfunktion för SVT Play-länk (förenklad)
function isValidSvtPlayUrl(url) {
    try {
        const parsedUrl = new URL(url);
        return parsedUrl.hostname.includes('svtplay.se');
    } catch (e) {
        return false;
    }
}

app.post('/generate-questions', async (req, res) => {
    const { svtLink, questionCount, questionType } = req.body;

    // Grundläggande validering på serversidan
    if (!svtLink || !isValidSvtPlayUrl(svtLink)) {
        return res.status(400).json({ error: 'Ogiltig eller saknad SVT Play-länk.' });
    }
    if (!questionCount || parseInt(questionCount, 10) < 1) {
        return res.status(400).json({ error: 'Antal frågor måste vara minst 1.' });
    }
    if (!questionType || !Array.isArray(questionType) || questionType.length === 0) {
        return res.status(400).json({ error: 'Minst en frågetyp måste väljas.' });
    }
    if (!openai) {
        console.error("Försök att generera frågor utan konfigurerad OpenAI API-nyckel.");
        return res.status(500).json({ error: 'OpenAI API-nyckel är inte konfigurerad på servern. Kontrollera serverloggarna och.env-filen.' });
    }

    // Skapa ett unikt filnamn för SRT-filen i systemets temporära katalog
    const srtFileName = `subtitle-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.srt`;
    const srtFilePath = path.join(os.tmpdir(), srtFileName);

    // Kommando för svtplay-dl. Inkludera -o för att specificera utdatafil. [1, 2]
    const command = `svtplay-dl -S --force-subtitle "${svtLink}" -o "${srtFilePath}"`;

    console.log(`Försöker ladda ner undertexter för: ${svtLink}`);
    console.log(`Exekverar kommando: ${command}`);

    exec(command, async (error, stdout, stderr) => {
        if (error) {
            console.error(`Fel vid körning av svtplay-dl (exit code: ${error.code}): ${error.message}`); // [3]
            console.error(`svtplay-dl stderr: ${stderr}`);
            // Försök radera temporär fil även vid fel, om den skapats
            try {
                if (await fs.stat(srtFilePath).catch(() => false)) { // Kontrollera om filen finns innan radering
                    await fs.unlink(srtFilePath);
                }
            } catch (e) {
                console.warn(`Kunde inte radera temporär fil ${srtFilePath} efter svtplay-dl fel: ${e.message}`);
            }
            return res.status(422).json({
                error: `Kunde inte hämta undertexter. Detaljer från svtplay-dl: ${stderr || error.message}`
            });
        }

        console.log(`svtplay-dl stdout: ${stdout}`);
        if (stderr) {
            // stderr kan innehålla varningar även vid lyckad körning
            console.warn(`svtplay-dl stderr (kan vara varningar): ${stderr}`);
        }

        let srtFileData;
        try {
            // Kontrollera om filen faktiskt skapades
            await fs.access(srtFilePath); // Kasta fel om filen inte finns
            srtFileData = await fs.readFile(srtFilePath, 'utf-8');
            if (!srtFileData || srtFileData.trim() === '') {
                throw new Error('SRT-filen är tom eller kunde inte läsas korrekt.');
            }
            console.log(`SRT-fil läst framgångsrikt: ${srtFilePath}`);
        } catch (fileError) {
            console.error(`Fel vid läsning av SRT-fil (${srtFilePath}): ${fileError.message}`);
            try {
                if (await fs.stat(srtFilePath).catch(() => false)) {
                    await fs.unlink(srtFilePath);
                }
            } catch (e) {
                console.warn(`Kunde inte radera temporär fil ${srtFilePath} efter läsfel: ${e.message}`);
            }
            return res.status(500).json({ error: `Kunde inte läsa undertextfilen. Detaljer: ${fileError.message}` });
        }

        // Radera temporär SRT-fil efter läsning
        try {
            await fs.unlink(srtFilePath);
            console.log(`Temporär fil raderad: ${srtFilePath}`);
        } catch (unlinkError) {
            console.error(`Kunde inte radera temporär fil ${srtFilePath}: ${unlinkError.message}`);
            // Fortsätt ändå, men logga felet. Detta är inte kritiskt för användaren.
        }

        const aiPrompt = `Här kommer en.srt-fil. Skapa ${questionCount} välformulerade instuderingsfrågor baserade helt på innehållet i texten. Varje fråga ska avslutas med en eller flera tidsstämplar där man kan börja titta för att hitta svaret, formaterade som [mm:ss]. Om svaret berör flera segment, ange samtliga relevanta tidsstämplar.
Använd följande frågetyper: ${questionType.join(', ')}.
Flervalsfrågor ska innehålla fyra trovärdiga alternativ där det inte är uppenbart vilket som är rätt. Undvik ledande eller alltför enkla svarsalternativ.

Undertext:
${srtFileData}`;

        try {
            console.log("Skickar prompt till OpenAI...");
            const completion = await openai.chat.completions.create({
                model: "gpt-3.5-turbo", // Du kan byta till "gpt-4o" om du har tillgång och vill ha potentiellt bättre resultat
                messages: [
                    { role: "system", content: "Du är en hjälpsam AI som skapar frågor baserade på undertexter." },
                    { role: "user", content: aiPrompt }
                ],
                // max_tokens: 2000, // Valfritt: justera baserat på förväntad längd och kostnad
                temperature: 0.7,
            });

            const generatedQuestionsText = completion.choices?.message?.content; // [4]
            if (!generatedQuestionsText) {
                console.error("OpenAI returnerade inget innehåll (choices.message.content var null/undefined).");
                throw new Error('OpenAI returnerade inget innehåll.');
            }
            console.log("Frågor mottagna från OpenAI.");

            // Dela upp i en array av frågor. Antag att frågor separeras av dubbla radbrytningar.
            // Anpassa detta om OpenAI returnerar ett annat format.
            const questionsArray = generatedQuestionsText.trim().split(/\n\s*\n|\n(?=\d+\.\s)/).map(q => q.trim()).filter(q => q.length > 0);

            res.status(200).json({ questions: questionsArray });

        } catch (aiError) {
            console.error(`Fel från OpenAI API: ${aiError.message}`);
            let statusCode = 500;
            let errorMessage = `Kunde inte generera frågor från AI. Detaljer: ${aiError.message}`;

            if (aiError instanceof OpenAI.APIError) { // [5]
                console.error('OpenAI API Error Details:', {
                    status: aiError.status,
                    type: aiError.type,
                    code: aiError.code,
                    param: aiError.param,
                });
                if (aiError.status === 401) {
                    statusCode = 401; // Unauthorized
                    errorMessage = "OpenAI API-nyckel är ogiltig eller saknar behörighet.";
                } else if (aiError.status === 429) {
                    statusCode = 429; // Rate limit
                    errorMessage = "För många anrop till OpenAI API. Försök igen senare.";
                } else {
                    statusCode = aiError.status || 500;
                }
            }
            res.status(statusCode).json({ error: errorMessage });
        }
    });
});

app.listen(PORT, () => {
    console.log(`Servern körs på http://localhost:${PORT}`);
    if (!process.env.OPENAI_API_KEY) {
        console.warn("VARNING: OPENAI_API_KEY är inte satt. Applikationen kommer inte att kunna generera frågor.");
    }
});