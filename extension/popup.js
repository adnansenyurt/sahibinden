console.log('Popup script loading...');

function initializePopup() {
    console.log('Initializing popup...');
    
    const testButton = document.querySelector('#testApi');
    const resultDiv = document.querySelector('#result');
    
    console.log('Elements found:', { 
        testButton: !!testButton, 
        resultDiv: !!resultDiv 
    });

    if (!testButton || !resultDiv) {
        console.error('Required elements not found');
        return;
    }

    testButton.addEventListener('click', async () => {
        try {
            resultDiv.className = 'loading';
            resultDiv.textContent = 'Testing...';

            const response = await fetch('http://localhost:3000/api/health');
            const data = await response.json();

            const date = new Date(data.timestamp);
            const formattedDate = date.toLocaleString();

            resultDiv.className = 'success';
            resultDiv.innerHTML = `
                Status: <span class="status">${data.status}</span><br>
                Time: <span class="time">${formattedDate}</span>
            `;
        } catch (error) {
            resultDiv.className = 'error';
            resultDiv.textContent = `Error: ${error.message}`;
        }
    });

    document.getElementById('syncNotes')?.addEventListener('click', async () => {
        const resultDiv = document.getElementById('result');
        try {
            resultDiv.textContent = 'Syncing...';
            const token = await chrome.storage.local.get('jwt_token');
            const response = await fetch('http://localhost:3000/api/notes', {
                headers: {
                    'Authorization': `Bearer ${token.jwt_token}`
                }
            });
            const notes = await response.json();
            
            // Update local storage with remote notes
            const updates = notes.reduce((acc, {adId, note}) => {
                acc[`note_${adId}`] = note;
                return acc;
            }, {});
            
            await chrome.storage.local.set(updates);
            resultDiv.textContent = 'Sync complete!';
        } catch (error) {
            resultDiv.textContent = `Sync failed: ${error.message}`;
        }
    });
}

// Ensure DOM is loaded
document.addEventListener('DOMContentLoaded', initializePopup);
