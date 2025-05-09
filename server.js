require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Initialize OpenAI API
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Set your OpenAI API key in an environment variable
});

app.post('/generate-questions', (req, res) => {
    const { svtLink, questionCount, questionType } = req.body;

    if (!svtLink) {
        return res.status(400).json({ message: 'SVT Play-länk saknas.' });
    }

    const subtitleFile = 'subtitles.srt'; // Ensure the file name matches the expected output

    // Run svtplay-dl to download subtitles
    exec(`svtplay-dl -S --force-subtitle ${svtLink} -o subtitles`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error: ${stderr}`);
            return res.status(500).json({ message: 'Kunde inte ladda ner undertexter.' });
        }

        // Rename the file if it has an extra.srt suffix
        const downloadedFile = 'subtitles.srt.srt';
        if (fs.existsSync(downloadedFile)) {
            fs.renameSync(downloadedFile, subtitleFile);
        }

        fs.readFile(subtitleFile, 'utf8', async (err, data) => {
            if (err) {
                console.error(`Error reading subtitle file: ${err}`);
                return res.status(500).json({ message: 'Kunde inte läsa undertextfilen.' });
            }

            // Anpassa antalet frågor i prompten baserat på questionCount
            const aiPrompt = `Här kommer en.srt-fil. Skapa ${questionCount} välformulerade instuderingsfrågor baserade helt på innehållet i texten. Varje fråga ska avslutas med en eller flera tidsstämplar där man kan börja titta för att hitta svaret, formaterade som [mm:ss]. Om svaret berör flera segment, ange samtliga relevanta tidsstämplar.\nAnvänd följande frågetyper: ${questionType.join(', ')}.\nFlervalsfrågor ska innehålla fyra trovärdiga alternativ där det inte är uppenbart vilket som är rätt. Undvik ledande eller alltför enkla svarsalternativ.\n\nUndertext:\n${data}`;

            try {
                // ÄNDRING 1: Använd openai.completions.create
                // ÄNDRING 2: Byt modell till gpt-3.5-turbo-instruct
                const response = await openai.completions.create({
                    model: 'gpt-3.5-turbo-instruct', // Korrekt modellnamn
                    prompt: aiPrompt,
                    max_tokens: 1500, // Du kan behöva justera detta beroende på önskad längd på svaret
                    temperature: 0.7,
                });

                // ÄNDRING 3: Korrekt åtkomst till svaret
                const questionsText = response.choices.text;
                const questions = questionsText.trim().split('\n').filter(q => q.length > 0); // Filtrera bort tomma rader

                res.json({ message: 'Frågor genererade!', questions });
            } catch (apiError) {
                console.error(`Error generating questions: ${apiError}`);
                // Logga mer detaljer om felet om möjligt
                if (apiError instanceof OpenAI.APIError) {
                    console.error('OpenAI API Error Details:', {
                        status: apiError.status,
                        type: apiError.type,
                        code: apiError.code,
                        param: apiError.param,
                        message: apiError.message,
                    });
                }
                res.status(500).json({ message: 'Kunde inte generera frågor med AI.' });
            }
        });
    });
});

app.listen(PORT, () => {
    console.log(`Servern körs på http://localhost:${PORT}`);
});