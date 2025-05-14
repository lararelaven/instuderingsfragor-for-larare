document.addEventListener('DOMContentLoaded', () => {
    const questionForm = document.getElementById('questionForm');
    const studentOutputDiv = document.getElementById('studentVersionOutput');
    const teacherOutputDiv = document.getElementById('teacherVersionOutput');
    const downloadWordButton = document.getElementById('downloadWordBtn');
    const generateButton = document.getElementById('generateBtn');
    const getAnswersButton = document.getElementById('getAnswersBtn');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const errorDisplay = document.getElementById('errorDisplay');
    const outputContainer = document.getElementById('outputContainer');
    const teacherColumn = document.getElementById('teacher-column');

    const mediaLinkInput = document.getElementById('mediaLink');
    const mcqCountInput = document.getElementById('mcqCount');
    const shortAnswerCountInput = document.getElementById('shortAnswerCount');
    const discussionCountInput = document.getElementById('discussionCount');

    const generatePromptButton = document.getElementById('generatePromptBtn');
    const promptOutputContainer = document.getElementById('promptOutputContainer');
    const generatedPromptTextarea = document.getElementById('generatedPromptOutput');
    const copyGeneratedPromptButton = document.getElementById('copyGeneratedPromptBtn');

    const downloadVideoBtn = document.getElementById('downloadVideoBtn'); // NYTT: Referens till knappen

    let generatedStudentQuestions = "";

    function resetUIState(isDownloadingVideo = false) { // Lade till parameter
        outputContainer.style.display = 'none';
        teacherColumn.style.display = 'none';
        errorDisplay.style.display = 'none';
        errorDisplay.textContent = '';
        loadingIndicator.style.display = 'none';
        downloadWordButton.style.display = 'none';
        getAnswersButton.style.display = 'none';
        promptOutputContainer.style.display = 'none';
        generatedPromptTextarea.value = '';
        studentOutputDiv.innerHTML = '';
        teacherOutputDiv.innerHTML = '';

        if (!isDownloadingVideo) { // Återställ inte dessa om videonedladdning pågår
            generateButton.disabled = false;
            generateButton.textContent = 'Generera elevfrågor';
            if (generatePromptButton) {
                generatePromptButton.disabled = false;
                generatePromptButton.textContent = 'Generera prompt för AI';
            }
        }
        getAnswersButton.disabled = false;
        getAnswersButton.textContent = 'Hämta facit';
        if (downloadVideoBtn) { // NYTT
            downloadVideoBtn.disabled = false;
            downloadVideoBtn.textContent = 'Hämta video';
        }
        if (copyGeneratedPromptButton) {
            const originalButtonText = "Kopiera texten";
            if (copyGeneratedPromptButton.textContent !== originalButtonText) {
                copyGeneratedPromptButton.textContent = originalButtonText;
            }
        }
    }

    resetUIState();

    if (questionForm) {
        questionForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            generatedStudentQuestions = "";
            resetUIState();

            const mediaLink = mediaLinkInput.value;
            const numMcq = parseInt(mcqCountInput.value) || 0;
            const numShortAnswer = parseInt(shortAnswerCountInput.value) || 0;
            const numDiscussion = parseInt(discussionCountInput.value) || 0;

            if (!mediaLink) {
                errorDisplay.textContent = 'Ange en SVT Play- eller YouTube-länk.';
                errorDisplay.style.display = 'block';
                return;
            }
            if (numMcq < 0 || numShortAnswer < 0 || numDiscussion < 0) {
                errorDisplay.textContent = 'Antal frågor kan inte vara negativt.';
                errorDisplay.style.display = 'block';
                return;
            }
            if (numMcq === 0 && numShortAnswer === 0 && numDiscussion === 0) {
                errorDisplay.textContent = 'Ange minst en fråga för någon frågetyp.';
                errorDisplay.style.display = 'block';
                return;
            }

            loadingIndicator.style.display = 'block';
            loadingIndicator.textContent = 'Genererar elevfrågor, vänligen vänta... ';
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            loadingIndicator.appendChild(spinner);
            generateButton.disabled = true;
            generateButton.textContent = 'Genererar elevfrågor...';
            if (generatePromptButton) generatePromptButton.disabled = true;
            if (downloadVideoBtn) downloadVideoBtn.disabled = true; // NYTT

            try {
                const response = await fetch('/generate-student-questions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mediaLink,
                        counts: {
                            flerval: numMcq,
                            kortsvar: numShortAnswer,
                            diskussion: numDiscussion
                        }
                    })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: `Serverfel vid generering av elevfrågor: ${response.status}` }));
                    throw new Error(errorData.error || `Serverfel: ${response.status}`);
                }
                const result = await response.json();
                if (result.studentText && result.studentText.trim() !== '') {
                    generatedStudentQuestions = result.studentText;
                    studentOutputDiv.innerHTML = formatStudentTextForDisplay(generatedStudentQuestions);
                    outputContainer.style.display = 'flex';
                    getAnswersButton.style.display = 'block';
                } else {
                    throw new Error('AI:n returnerade inget innehåll för elevfrågor.');
                }
            } catch (error) {
                console.error('Fel vid generering av elevfrågor:', error);
                errorDisplay.textContent = `Fel: ${error.message}`;
                errorDisplay.style.display = 'block';
            } finally {
                loadingIndicator.style.display = 'none';
                generateButton.disabled = false;
                generateButton.textContent = 'Generera elevfrågor';
                if (generatePromptButton) generatePromptButton.disabled = false;
                if (downloadVideoBtn) downloadVideoBtn.disabled = false; // NYTT
            }
        });
    }

    if (getAnswersButton) {
        getAnswersButton.addEventListener('click', async function () {
            if (!generatedStudentQuestions) {
                alert("Inga elevfrågor att hämta facit för.");
                return;
            }
            teacherOutputDiv.innerHTML = '';
            errorDisplay.style.display = 'none';
            loadingIndicator.style.display = 'block';
            loadingIndicator.textContent = 'Hämtar facit, vänligen vänta... ';
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            loadingIndicator.appendChild(spinner);
            getAnswersButton.disabled = true;
            getAnswersButton.textContent = 'Hämtar facit...';
            generateButton.disabled = true;
            if (generatePromptButton) generatePromptButton.disabled = true;
            if (downloadVideoBtn) downloadVideoBtn.disabled = true; // NYTT

            try {
                const response = await fetch('/generate-teacher-answers', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        studentQuestions: generatedStudentQuestions,
                        mediaLink: mediaLinkInput.value
                    })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: `Serverfel vid hämtning av facit: ${response.status}` }));
                    throw new Error(errorData.error || `Serverfel: ${response.status}`);
                }
                const result = await response.json();
                if (result.teacherText && result.teacherText.trim() !== '') {
                    teacherOutputDiv.innerHTML = formatTeacherTextForDisplay(result.teacherText);
                    teacherColumn.style.display = 'block';
                    downloadWordButton.style.display = 'block';
                } else {
                    throw new Error('AI:n returnerade inget innehåll för facit.');
                }
            } catch (error) {
                console.error('Fel vid hämtning av facit:', error);
                errorDisplay.textContent = `Fel vid hämtning av facit: ${error.message}`;
                errorDisplay.style.display = 'block';
            } finally {
                loadingIndicator.style.display = 'none';
                getAnswersButton.disabled = false;
                getAnswersButton.textContent = 'Hämta facit';
                generateButton.disabled = false;
                if (generatePromptButton) generatePromptButton.disabled = false;
                if (downloadVideoBtn) downloadVideoBtn.disabled = false; // NYTT
            }
        });
    }

    if (generatePromptButton) {
        generatePromptButton.addEventListener('click', async function () {
            resetUIState();
            const mediaLink = mediaLinkInput.value;
            const numMcq = parseInt(mcqCountInput.value) || 0;
            const numShortAnswer = parseInt(shortAnswerCountInput.value) || 0;
            const numDiscussion = parseInt(discussionCountInput.value) || 0;

            if (!mediaLink) {
                errorDisplay.textContent = 'Ange en SVT Play- eller YouTube-länk.';
                errorDisplay.style.display = 'block';
                return;
            }
            if (numMcq < 0 || numShortAnswer < 0 || numDiscussion < 0) {
                errorDisplay.textContent = 'Antal frågor kan inte vara negativt.';
                errorDisplay.style.display = 'block';
                return;
            }
            if (numMcq === 0 && numShortAnswer === 0 && numDiscussion === 0) {
                errorDisplay.textContent = 'Ange minst en fråga för någon frågetyp för att generera en meningsfull prompt.';
                errorDisplay.style.display = 'block';
                return;
            }

            loadingIndicator.style.display = 'block';
            loadingIndicator.textContent = 'Genererar prompt-text, vänligen vänta... ';
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            loadingIndicator.appendChild(spinner);
            generatePromptButton.disabled = true;
            generatePromptButton.textContent = 'Genererar prompt...';
            generateButton.disabled = true;
            if (downloadVideoBtn) downloadVideoBtn.disabled = true; // NYTT


            try {
                const response = await fetch('/generate-ai-prompt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mediaLink,
                        counts: {
                            flerval: numMcq,
                            kortsvar: numShortAnswer,
                            diskussion: numDiscussion
                        }
                    })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: `Serverfel när prompt genererades: ${response.status}` }));
                    throw new Error(errorData.error || `Serverfel: ${response.status}`);
                }
                const result = await response.json();
                if (result.promptText) {
                    generatedPromptTextarea.value = result.promptText;
                    promptOutputContainer.style.display = 'block';
                } else {
                    throw new Error('Servern returnerade ingen prompttext.');
                }
            } catch (error) {
                console.error('Fel vid generering av AI-prompt:', error);
                errorDisplay.textContent = `Fel: ${error.message}`;
                errorDisplay.style.display = 'block';
            } finally {
                loadingIndicator.style.display = 'none';
                generatePromptButton.disabled = false;
                generatePromptButton.textContent = 'Generera prompt för AI';
                generateButton.disabled = false;
                if (downloadVideoBtn) downloadVideoBtn.disabled = false; // NYTT
            }
        });
    }

    // NYTT: Event listener för "Hämta video"-knappen
    if (downloadVideoBtn) {
        downloadVideoBtn.addEventListener('click', async function () {
            resetUIState(true); // Skicka true för att inte återställa "Generera frågor/prompt"-knapparna
            const mediaLink = mediaLinkInput.value;

            if (!mediaLink) {
                errorDisplay.textContent = 'Ange en SVT Play- eller YouTube-länk för att kunna ladda ner videon.';
                errorDisplay.style.display = 'block';
                return;
            }

            loadingIndicator.style.display = 'block';
            loadingIndicator.textContent = 'Förbereder nedladdning av video, detta kan ta en stund... ';
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            loadingIndicator.appendChild(spinner);
            downloadVideoBtn.disabled = true;
            downloadVideoBtn.textContent = 'Hämtar video...';
            // Inaktivera även andra huvudknappar under nedladdning
            generateButton.disabled = true;
            if (generatePromptButton) generatePromptButton.disabled = true;


            try {
                const response = await fetch('/download-video', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mediaLink })
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: `Serverfel vid videonedladdning: ${response.status}` }));
                    throw new Error(errorData.error || `Serverfel: ${response.status}`);
                }

                // Hantera filnedladdningen
                const disposition = response.headers.get('Content-Disposition');
                let filename = 'video.mkv'; // Default filnamn
                if (disposition && disposition.includes('attachment')) {
                    const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
                    if (filenameMatch && filenameMatch[1]) {
                        filename = filenameMatch[1];
                    }
                }

                loadingIndicator.textContent = 'Laddar ner video...'; // Uppdatera meddelande

                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);

                loadingIndicator.textContent = 'Videonedladdning slutförd!';
                setTimeout(() => { // Dölj meddelandet efter en stund
                    if (loadingIndicator.textContent === 'Videonedladdning slutförd!') {
                        loadingIndicator.style.display = 'none';
                    }
                }, 3000);

            } catch (error) {
                console.error('Fel vid nedladdning av video:', error);
                errorDisplay.textContent = `Fel vid videonedladdning: ${error.message}`;
                errorDisplay.style.display = 'block';
                loadingIndicator.style.display = 'none';
            } finally {
                // Återaktivera knappar efter nedladdningsförsök
                downloadVideoBtn.disabled = false;
                downloadVideoBtn.textContent = 'Hämta video';
                generateButton.disabled = false; // Återaktivera alltid
                if (generatePromptButton) generatePromptButton.disabled = false; // Återaktivera alltid
            }
        });
    }


    if (copyGeneratedPromptButton) {
        copyGeneratedPromptButton.addEventListener('click', () => {
            if (!generatedPromptTextarea.value) {
                const originalButtonText = copyGeneratedPromptButton.textContent;
                copyGeneratedPromptButton.textContent = 'Inget att kopiera';
                setTimeout(() => {
                    copyGeneratedPromptButton.textContent = originalButtonText;
                }, 2000);
                return;
            }
            generatedPromptTextarea.select();
            generatedPromptTextarea.setSelectionRange(0, 99999);
            try {
                const successful = document.execCommand('copy');
                const originalButtonText = copyGeneratedPromptButton.textContent;
                const msg = successful ? 'Kopierad!' : 'Kunde inte kopiera';
                copyGeneratedPromptButton.textContent = msg;
                setTimeout(() => {
                    copyGeneratedPromptButton.textContent = originalButtonText;
                }, 2000);
            } catch (err) {
                const originalButtonText = copyGeneratedPromptButton.textContent;
                copyGeneratedPromptButton.textContent = 'Fel vid kopiering';
                setTimeout(() => {
                    copyGeneratedPromptButton.textContent = originalButtonText;
                }, 2000);
            }
            window.getSelection().removeAllRanges();
        });
    }

    function formatTimestamp(rawTimestamp) {
        if (!rawTimestamp || !rawTimestamp.includes('[')) return '';
        let ts = rawTimestamp.trim();
        // Försök matcha [hh:mm:ss] --> [hh:mm:ss] eller [mm:ss] --> [mm:ss] etc.
        const intervalMatch = ts.match(/\[((?:\d{2,}:)?\d{2}:\d{2}(?:[,.]\d{1,3})?)\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}(?:[,.]\d{1,3})?)\]/);
        if (intervalMatch) {
            let startStr = intervalMatch[1];
            let endStr = intervalMatch[2];
            // Förenkla om timmar är 00
            startStr = startStr.replace(/^(00:)+/, '');
            endStr = endStr.replace(/^(00:)+/, '');
            if (startStr === endStr) return `[${startStr}]`; // Om start och slut är samma, visa bara en gång
            return `[${startStr} - ${endStr}]`;
        }
        // Försök matcha enskild tidsstämpel [hh:mm:ss] eller [mm:ss]
        const singleMatch = ts.match(/\[((?:\d{2,}:)?\d{2}:\d{2}(?:[,.]\d{1,3})?)\]/);
        if (singleMatch) {
            let timeStr = singleMatch[1];
            timeStr = timeStr.replace(/^(00:)+/, '');
            return `[${timeStr}]`;
        }
        if (ts.startsWith("[") && ts.endsWith("]")) { // Fallback om det är något annat inom [ ]
            return ts;
        }
        return ''; // Returnera tom sträng om inget känns igen
    }


    function formatStudentTextForDisplay(text) {
        if (!text || text.trim() === '') return '<p>Inga frågor att visa.</p>';
        if (text.includes("KUNDE INTE EXTRAHERAS")) return `<p style="color: red;">${text.replace(/\n/g, '<br>')}</p>`;

        // Använd en mer "rå" rendering tills vidare om AI:n sköter formateringen väl
        return `<pre style="white-space: pre-wrap; word-wrap: break-word;">${text}</pre>`;
    }

    function formatTeacherTextForDisplay(text) {
        if (!text || text.trim() === '') return '<p>Inget facit att visa.</p>';
        if (text.includes("KUNDE INTE EXTRAHERAS")) return `<p style="color: red;">${text.replace(/\n/g, '<br>')}</p>`;

        // Använd en mer "rå" rendering tills vidare
        return `<pre style="white-space: pre-wrap; word-wrap: break-word;">${text}</pre>`;
    }

    if (downloadWordButton) {
        downloadWordButton.addEventListener('click', function () {
            let studentHtmlForDoc = studentOutputDiv.innerHTML; // Tar nu innehållet i <pre>
            let teacherHtmlForDoc = teacherColumn.style.display !== 'none' ? teacherOutputDiv.innerHTML : "";

            // Funktion för att konvertera <pre>-formaterad text till HTML som ser bra ut i Word
            function preToWordHtml(preContent) {
                if (!preContent.startsWith('<pre')) return preContent; // Om det inte är pre, returnera som det är
                let text = preContent.replace(/<pre[^>]*>/i, '').replace(/<\/pre>/i, ''); // Ta bort <pre>-taggar
                text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); // Avkoda HTML-entiteter

                // Dela upp i frågeblock baserat på numrering
                const questionBlocks = text.split(/\n(?=\s*\d+\.\s)/m);
                let html = '';

                questionBlocks.forEach(block => {
                    if (block.trim() === '') return;
                    html += '<div style="margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px dashed #ccc; page-break-inside: avoid;">';
                    const lines = block.trim().split('\n');
                    html += `<p style="font-weight: bold; margin-bottom: 6px;">${lines[0]}</p>`; // Frågerad

                    if (lines.length > 1) {
                        let isMcq = lines.slice(1).some(l => l.match(/^\s*[A-D][.)]\s+/i));
                        if (isMcq) {
                            html += '<ul style="list-style-type: none; padding-left: 20px; margin-top: 4px; margin-bottom: 8px;">';
                            lines.slice(1).forEach(line => {
                                if (line.match(/^\s*[A-D][.)]\s+/i)) {
                                    html += `<li style="margin-bottom: 3px;">${line.trim()}</li>`;
                                } else if (line.trim().toLowerCase().startsWith('rätt svar:') || line.trim().toLowerCase().startsWith('svar:') || line.trim().toLowerCase().startsWith('förslag på svar:')) {
                                    // Detta är för facit, hanteras nedan om teacherHtmlForDoc
                                }
                            });
                            html += '</ul>';
                        }
                        // Hantera svarstext för facitdelen
                        if (teacherHtmlForDoc && preContent === teacherOutputDiv.innerHTML) { // Endast för lärarversionens block
                            lines.slice(1).forEach(line => {
                                const trimmedLine = line.trim();
                                if (trimmedLine.toLowerCase().startsWith('rätt svar:') || trimmedLine.toLowerCase().startsWith('svar:') || trimmedLine.toLowerCase().startsWith('förslag på svar:')) {
                                    html += `<p style="margin-top: 6px;"><strong>${trimmedLine.substring(0, trimmedLine.indexOf(':') + 1)}</strong>${trimmedLine.substring(trimmedLine.indexOf(':') + 1)}</p>`;
                                }
                            });
                        }
                    }
                    html += '</div>';
                });
                return html;
            }


            studentHtmlForDoc = preToWordHtml(studentOutputDiv.innerHTML);
            if (teacherHtmlForDoc) {
                teacherHtmlForDoc = preToWordHtml(teacherOutputDiv.innerHTML);
            }


            if (!studentHtmlForDoc.includes('<p')) { // Enkel kontroll om det finns formaterat innehåll
                alert('Det finns inga frågor att ladda ner (eller fel vid formatering).');
                return;
            }

            const mediaLinkValue = mediaLinkInput.value;
            const programTitle = mediaLinkValue.split('/').filter(Boolean).pop()?.split('?')[0] || "Okant_Program";

            let htmlContent = `
                <!DOCTYPE html>
                <html lang="sv">
                <head>
                    <meta charset="UTF-8">
                    <title>Instuderingsfrågor - ${programTitle}</title>
                    <style>
                        body { font-family: Calibri, Arial, sans-serif; line-height: 1.5; margin: 20px; font-size: 11pt; }
                        h1 { font-size: 16pt; color: #2E74B5; margin-bottom: 10px; }
                        h2 { font-size: 14pt; color: #2E74B5; margin-top: 20px; margin-bottom: 10px; border-bottom: 1px solid #AEB6BF; padding-bottom: 3px;}
                        /* Ta bort generell div > div styling och lita på preToWordHtml's styling */
                    </style>
                </head>
                <body>
                    <h1>Instuderingsfrågor för: ${programTitle}</h1>
                    <div><h2>📘 Elevversion – Instuderingsfrågor (utan svar)</h2>${studentHtmlForDoc}</div>
                    ${teacherHtmlForDoc ?
                    `<hr style="margin-top: 25px; margin-bottom: 25px; border: none; border-top: 1px solid #AEB6BF;">
                         <div><h2>👩‍🏫 Lärarversion – Med facit</h2>${teacherHtmlForDoc}</div>`
                    : ''}
                </body>
                </html>`;

            const blob = new Blob([htmlContent], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document;charset=utf-8' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `Instuderingsfrågor - ${programTitle.replace(/[\\/:*?"<>|]/g, '_')}.docx`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(link.href);
        });
    }
});