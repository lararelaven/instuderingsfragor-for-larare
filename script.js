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
    
    const downloadVideoBtn = document.getElementById('downloadVideoBtn');

    let generatedStudentQuestions = "";
    let currentVideoJobId = null;
    let pollIntervalId = null;

    // Funktion för att uppdatera UI-status (generell laddningsindikator och felmeddelanden)
    function updateGlobalLoadingState(isLoading, message = 'Bearbetar, vänligen vänta...') {
        if (isLoading) {
            loadingIndicator.innerHTML = `${message} <span class="spinner"></span>`; // Inkludera spinner
            loadingIndicator.style.display = 'flex'; // Använd flex för att centrera spinnern
        } else {
            loadingIndicator.style.display = 'none';
            loadingIndicator.innerHTML = ''; // Rensa innehåll
        }
    }

    function displayGlobalError(errorMessage) {
        errorDisplay.textContent = errorMessage;
        errorDisplay.style.display = 'block';
        updateGlobalLoadingState(false); // Dölj laddningsindikatorn om ett fel visas
    }

    function clearGlobalError() {
        errorDisplay.textContent = '';
        errorDisplay.style.display = 'none';
    }

    // Dedikerad funktion för att hantera videonedladdnings-UI och status
    function updateVideoDownloadStatusUI(statusMessage, isError = false, showSpinner = false) {
        // Använd loadingIndicator för videostatus för enkelhetens skull,
        // men du kan skapa ett dedikerat element för detta.
        if (statusMessage || showSpinner) {
            loadingIndicator.style.display = 'flex';
            let textContent = statusMessage || (showSpinner ? 'Bearbetar video...' : '');
            loadingIndicator.innerHTML = `${textContent} ${showSpinner ? '<span class="spinner"></span>' : ''}`;
            if (isError) {
                // Om det är ett fel specifikt för video, kan vi visa det i errorDisplay också
                // eller direkt i loadingIndicator. Här väljer vi errorDisplay.
                errorDisplay.textContent = statusMessage;
                errorDisplay.style.display = 'block';
                loadingIndicator.style.color = 'red'; // Gör texten röd i loadingIndicator också
            } else {
                 loadingIndicator.style.color = ''; // Återställ textfärg
                 clearGlobalError(); // Rensa globala fel om videostatus är ok
            }
        } else {
            // Om inget meddelande och ingen spinner, dölj bara om det var ett videomeddelande
            if (loadingIndicator.innerHTML.includes('video') || loadingIndicator.innerHTML.includes('Jobb ID')) {
                 loadingIndicator.style.display = 'none';
                 loadingIndicator.innerHTML = '';
                 loadingIndicator.style.color = '';
            }
        }
        loadingIndicator.onclick = null; // Ta bort eventuell gammal klickhanterare
        loadingIndicator.style.cursor = 'default';
    }


    function resetUIState() {
        outputContainer.style.display = 'none';
        teacherColumn.style.display = 'none';
        clearGlobalError();
        updateGlobalLoadingState(false);
        
        downloadWordButton.style.display = 'none';
        getAnswersButton.style.display = 'none';
        promptOutputContainer.style.display = 'none';
        generatedPromptTextarea.value = '';
        studentOutputDiv.innerHTML = '';
        teacherOutputDiv.innerHTML = '';

        generateButton.disabled = false;
        generateButton.textContent = 'Generera elevfrågor';
        if (generatePromptButton) {
            generatePromptButton.disabled = false;
            generatePromptButton.textContent = 'Generera prompt för AI';
        }
        getAnswersButton.disabled = false;
        getAnswersButton.textContent = 'Hämta facit';
        
        // Återställ videonedladdningsknappen och rensa jobbinfo
        if (downloadVideoBtn) {
            downloadVideoBtn.disabled = false;
            downloadVideoBtn.textContent = 'Hämta video';
        }
        if (pollIntervalId) {
            clearInterval(pollIntervalId);
            pollIntervalId = null;
        }
        currentVideoJobId = null;
        updateVideoDownloadStatusUI(''); // Rensa specifik videostatus
    }

    resetUIState(); // Initial återställning

    if (questionForm) {
        questionForm.addEventListener('submit', async function (event) {
            event.preventDefault();
            generatedStudentQuestions = ""; // Nollställ tidigare frågor
            resetUIState(); 

            const mediaLink = mediaLinkInput.value;
            const numMcq = parseInt(mcqCountInput.value) || 0;
            const numShortAnswer = parseInt(shortAnswerCountInput.value) || 0;
            const numDiscussion = parseInt(discussionCountInput.value) || 0;

            if (!mediaLink) {
                displayGlobalError('Ange en SVT Play- eller YouTube-länk.');
                return;
            }
            if (numMcq < 0 || numShortAnswer < 0 || numDiscussion < 0) {
                displayGlobalError('Antal frågor kan inte vara negativt.');
                return;
            }
            if (numMcq === 0 && numShortAnswer === 0 && numDiscussion === 0) {
                displayGlobalError('Ange minst en fråga för någon frågetyp.');
                return;
            }

            updateGlobalLoadingState(true, 'Genererar elevfrågor, vänligen vänta...');
            generateButton.disabled = true;
            generateButton.textContent = 'Genererar elevfrågor...';
            if (generatePromptButton) generatePromptButton.disabled = true;
            if (downloadVideoBtn) downloadVideoBtn.disabled = true;

            try {
                const response = await fetch('/generate-student-questions', { /* ... som tidigare ... */ 
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mediaLink,
                        counts: { flerval: numMcq, kortsvar: numShortAnswer, diskussion: numDiscussion }
                    })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: `Serverfel vid generering: ${response.status}` }));
                    throw new Error(errorData.error || `Serverfel: ${response.status}`);
                }
                const result = await response.json();
                if (result.studentText && result.studentText.trim() !== '') {
                    generatedStudentQuestions = result.studentText;
                    studentOutputDiv.innerHTML = formatStudentTextForDisplay(generatedStudentQuestions);
                    outputContainer.style.display = 'flex';
                    getAnswersButton.style.display = 'block';
                    clearGlobalError();
                } else {
                    throw new Error('AI:n returnerade inget innehåll för elevfrågor.');
                }
            } catch (error) {
                console.error('Fel vid generering av elevfrågor:', error);
                displayGlobalError(`Fel: ${error.message}`);
            } finally {
                updateGlobalLoadingState(false);
                generateButton.disabled = false;
                generateButton.textContent = 'Generera elevfrågor';
                if (generatePromptButton) generatePromptButton.disabled = false;
                if (downloadVideoBtn) downloadVideoBtn.disabled = false;
            }
        });
    }

    if (getAnswersButton) {
        getAnswersButton.addEventListener('click', async function () {
            // ... (liknande logik som i questionForm.addEventListener, använd updateGlobalLoadingState och displayGlobalError)
            if (!generatedStudentQuestions) {
                alert("Inga elevfrågor att hämta facit för.");
                return;
            }
            teacherOutputDiv.innerHTML = ''; // Rensa tidigare facit
            clearGlobalError();
            updateGlobalLoadingState(true, 'Hämtar facit, vänligen vänta...');
            getAnswersButton.disabled = true;
            getAnswersButton.textContent = 'Hämtar facit...';
            generateButton.disabled = true; // Inaktivera andra knappar
            if (generatePromptButton) generatePromptButton.disabled = true;
            if (downloadVideoBtn) downloadVideoBtn.disabled = true;


            try {
                const response = await fetch('/generate-teacher-answers', { /* ... som tidigare ... */ 
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
                    clearGlobalError();
                } else {
                    throw new Error('AI:n returnerade inget innehåll för facit.');
                }
            } catch (error) {
                console.error('Fel vid hämtning av facit:', error);
                displayGlobalError(`Fel vid hämtning av facit: ${error.message}`);
            } finally {
                updateGlobalLoadingState(false);
                getAnswersButton.disabled = false;
                getAnswersButton.textContent = 'Hämta facit';
                // Återaktivera huvudknapparna om inga videoprocesser körs
                if (!currentVideoJobId) { 
                    generateButton.disabled = false;
                    if (generatePromptButton) generatePromptButton.disabled = false;
                    if (downloadVideoBtn) downloadVideoBtn.disabled = false;
                }
            }
        });
    }
    
    if (generatePromptButton) {
        generatePromptButton.addEventListener('click', async function () {
            // ... (liknande logik, använd updateGlobalLoadingState och displayGlobalError)
            resetUIState(); // Återställ allt innan promptgenerering
            const mediaLink = mediaLinkInput.value;
            const numMcq = parseInt(mcqCountInput.value) || 0;
            const numShortAnswer = parseInt(shortAnswerCountInput.value) || 0;
            const numDiscussion = parseInt(discussionCountInput.value) || 0;

            if (!mediaLink) {
                displayGlobalError('Ange en SVT Play- eller YouTube-länk.');
                return;
            }
            // ... (validering av counts som tidigare)

            updateGlobalLoadingState(true, 'Genererar prompt-text, vänligen vänta...');
            generatePromptButton.disabled = true;
            generatePromptButton.textContent = 'Genererar prompt...';
            generateButton.disabled = true;
            if (downloadVideoBtn) downloadVideoBtn.disabled = true;

            try {
                const response = await fetch('/generate-ai-prompt', { /* ... som tidigare ... */ 
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mediaLink,
                        counts: { flerval: numMcq, kortsvar: numShortAnswer, diskussion: numDiscussion }
                    })
                });
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: `Serverfel när prompt genererades: ${response.status}`}));
                    throw new Error(errorData.error || `Serverfel: ${response.status}`);
                }
                const result = await response.json();
                if (result.promptText) {
                    generatedPromptTextarea.value = result.promptText;
                    promptOutputContainer.style.display = 'block';
                    clearGlobalError();
                } else {
                    throw new Error('Servern returnerade ingen prompttext.');
                }
            } catch (error) {
                console.error('Fel vid generering av AI-prompt:', error);
                displayGlobalError(`Fel: ${error.message}`);
            } finally {
                updateGlobalLoadingState(false);
                generatePromptButton.disabled = false;
                generatePromptButton.textContent = 'Generera prompt för AI';
                generateButton.disabled = false;
                if (downloadVideoBtn) downloadVideoBtn.disabled = false;
            }
        });
    }

    // --- NY LOGIK FÖR ASYNKRON VIDEONEDLADDNING ---
    if (downloadVideoBtn) {
        downloadVideoBtn.addEventListener('click', async function () {
            // Återställ bara videorelaterat UI, inte frågedelen om den är aktiv
            if (pollIntervalId) clearInterval(pollIntervalId);
            currentVideoJobId = null;
            updateVideoDownloadStatusUI(''); // Rensa tidigare videostatus
            clearGlobalError(); // Rensa eventuella globala fel

            const mediaLink = mediaLinkInput.value;
            if (!mediaLink) {
                updateVideoDownloadStatusUI('Ange en media-länk för att ladda ner video.', true);
                return;
            }

            downloadVideoBtn.disabled = true;
            downloadVideoBtn.textContent = 'Initierar...';
            updateVideoDownloadStatusUI('Förbereder nedladdning...', false, true);
            // Inaktivera andra huvudknappar under nedladdningsprocessen
            generateButton.disabled = true;
            if (generatePromptButton) generatePromptButton.disabled = true;


            try {
                const response = await fetch('/initiate-video-download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mediaLink })
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: `Serverfel vid initiering: ${response.status}` }));
                    throw new Error(errorData.error || `Serverfel: ${response.status}`);
                }

                const result = await response.json();
                currentVideoJobId = result.jobId;
                updateVideoDownloadStatusUI(`Nedladdning påbörjad (ID: ${currentVideoJobId}). Kontrollerar status...`, false, true);
                downloadVideoBtn.textContent = 'Pågår...';
                
                pollIntervalId = setInterval(checkVideoStatus, 5000); // Kolla var 5:e sekund

            } catch (error) {
                console.error('Fel vid initiering av videonedladdning:', error);
                updateVideoDownloadStatusUI(`Fel vid initiering: ${error.message}`, true);
                downloadVideoBtn.disabled = false;
                downloadVideoBtn.textContent = 'Hämta video';
                // Återaktivera andra knappar om initiering misslyckas
                generateButton.disabled = false;
                if (generatePromptButton) generatePromptButton.disabled = false;
            }
        });
    }

    async function checkVideoStatus() {
        if (!currentVideoJobId) {
            if (pollIntervalId) clearInterval(pollIntervalId);
            return;
        }

        try {
            const response = await fetch(`/video-download-status/${currentVideoJobId}`);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: `Serverfel (${response.status})` }));
                console.warn('Fel vid statuskontroll, avbryter polling för jobb:', currentVideoJobId, errorData.error);
                updateVideoDownloadStatusUI(`Kunde inte hämta status: ${errorData.error || response.statusText}. Försök igen.`, true);
                clearInterval(pollIntervalId);
                pollIntervalId = null;
                downloadVideoBtn.disabled = false;
                downloadVideoBtn.textContent = 'Hämta video';
                currentVideoJobId = null;
                // Återaktivera andra knappar
                generateButton.disabled = false;
                if (generatePromptButton) generatePromptButton.disabled = false;
                return;
            }

            const result = await response.json();
            console.log('Status:', result);

            if (result.status === 'completed') {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
                updateVideoDownloadStatusUI(`Video "${result.fileName || 'filen'}" är klar! Klicka för att ladda ner.`, false, false);
                
                loadingIndicator.onclick = () => { // Använd loadingIndicator som klickbar yta
                    window.location.href = `/get-downloaded-video/${currentVideoJobId}`;
                    // Återställ UI efter att användaren klickat (eller efter en timeout)
                    setTimeout(() => {
                        updateVideoDownloadStatusUI('');
                        downloadVideoBtn.disabled = false;
                        downloadVideoBtn.textContent = 'Hämta video';
                        currentVideoJobId = null;
                        // Återaktivera andra knappar
                        generateButton.disabled = false;
                        if (generatePromptButton) generatePromptButton.disabled = false;
                    }, 2000);
                };
                loadingIndicator.style.cursor = 'pointer';
                downloadVideoBtn.textContent = 'Färdig!';
                downloadVideoBtn.disabled = false; // Gör huvudknappen klickbar igen också

            } else if (result.status === 'failed') {
                clearInterval(pollIntervalId);
                pollIntervalId = null;
                updateVideoDownloadStatusUI(`Nedladdning misslyckades: ${result.error || 'Okänt fel'}`, true);
                downloadVideoBtn.disabled = false;
                downloadVideoBtn.textContent = 'Hämta video (Försök igen)';
                currentVideoJobId = null;
                // Återaktivera andra knappar
                generateButton.disabled = false;
                if (generatePromptButton) generatePromptButton.disabled = false;

            } else if (result.status === 'processing') {
                updateVideoDownloadStatusUI('Videon bearbetas fortfarande på servern...', false, true);
                downloadVideoBtn.textContent = 'Bearbetar...';
            } else if (result.status === 'pending') {
                updateVideoDownloadStatusUI('Väntar på att starta bearbetning...', false, true);
                downloadVideoBtn.textContent = 'Väntar...';
            }
        } catch (error) {
            console.error('Nätverksfel vid statuskontroll:', error);
            // Behåll pollingen vid nätverksfel, men meddela användaren
            updateVideoDownloadStatusUI('Nätverksfel vid statuskontroll. Försöker igen...', true, true);
        }
    }


    if (copyGeneratedPromptButton) {
        copyGeneratedPromptButton.addEventListener('click', () => {
            // ... (din befintliga kopieringslogik)
            if (!generatedPromptTextarea.value) { /* ... */ }
            generatedPromptTextarea.select();
            // ...
        });
    }

    // Behåll dina formatStudentTextForDisplay och formatTeacherTextForDisplay funktioner
    function formatStudentTextForDisplay(text) {
        if (!text || text.trim() === '') return '<p>Inga frågor att visa.</p>';
        return `<pre style="white-space: pre-wrap; word-wrap: break-word;">${text}</pre>`;
    }

    function formatTeacherTextForDisplay(text) {
        if (!text || text.trim() === '') return '<p>Inget facit att visa.</p>';
        return `<pre style="white-space: pre-wrap; word-wrap: break-word;">${text}</pre>`;
    }
    
    if (downloadWordButton) {
        downloadWordButton.addEventListener('click', function () {
            // ... (din befintliga Word-nedladdningslogik) ...
        });
    }
});
