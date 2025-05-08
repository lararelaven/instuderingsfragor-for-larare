document.getElementById('questionForm').addEventListener('submit', async function (event) {
    event.preventDefault();

    const svtLink = document.getElementById('svtLink').value;
    const questionCount = document.getElementById('questionCount').value;
    const questionType = Array.from(document.getElementById('questionType').selectedOptions).map(option => option.value);

    const response = await fetch('/generate-questions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ svtLink, questionCount, questionType })
    });

    const result = await response.json();
    const questionsOutput = document.getElementById('questionsOutput');
    questionsOutput.value = result.questions.join('\n');
});

document.getElementById('downloadWord').addEventListener('click', function () {
    const questions = document.getElementById('questionsOutput').value;
    const blob = new Blob([questions], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'questions.docx';
    link.click();
});