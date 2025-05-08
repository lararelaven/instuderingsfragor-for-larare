const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { OpenAIApi, Configuration } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Initialize OpenAI API
const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY, // Set your OpenAI API key in an environment variable
});
const openai = new OpenAIApi(configuration);

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

        // Rename the file if it has an extra .srt suffix
        const downloadedFile = 'subtitles.srt.srt';
        if (fs.existsSync(downloadedFile)) {
            fs.renameSync(downloadedFile, subtitleFile);
        }

        // Simulate AI processing for generating questions
        fs.readFile(subtitleFile, 'utf8', async (err, data) => {
            if (err) {
                console.error(`Error reading subtitle file: ${err}`);
                return res.status(500).json({ message: 'Kunde inte läsa undertextfilen.' });
            }

            const aiPrompt = `Här kommer en .srt-fil. Skapa 10 välformulerade instuderingsfrågor baserade helt på innehållet i texten. Varje fråga ska avslutas med en eller flera tidsstämplar där man kan börja titta för att hitta svaret, formaterade som [mm:ss]. Om svaret berör flera segment, ange samtliga relevanta tidsstämplar.\nAnvänd följande frågetyper: ${questionType.join(', ')}.\nFlervalsfrågor ska innehålla fyra trovärdiga alternativ där det inte är uppenbart vilket som är rätt. Undvik ledande eller alltför enkla svarsalternativ.\n\nUndertext:\n${data}`;

            try {
                const response = await openai.createCompletion({
                    model: 'text-davinci-003',
                    prompt: aiPrompt,
                    max_tokens: 1500,
                    temperature: 0.7,
                });

                const questions = response.data.choices[0].text.trim().split('\n');
                res.json({ message: 'Frågor genererade!', questions });
            } catch (apiError) {
                console.error(`Error generating questions: ${apiError}`);
                res.status(500).json({ message: 'Kunde inte generera frågor med AI.' });
            }
        });
    });
});

app.listen(PORT, () => {
    console.log(`Servern körs på http://localhost:${PORT}`);
});