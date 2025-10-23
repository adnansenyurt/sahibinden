console.log('Sahibinden Notes: Starting...');

document.addEventListener('DOMContentLoaded', () => {
    function setupNoteBoxes() {
        const adRows = document.querySelectorAll('tr[data-id]');
        console.log(`Processing ${adRows.length} ad rows`);

        adRows.forEach(row => {
            const imgCell = row.querySelector('td:first-child');
            if (!imgCell) return;

            imgCell.style.position = 'relative';
            
            row.addEventListener('mouseenter', () => {
                const noteBox = document.createElement('div');
                noteBox.className = 'note-box';
                noteBox.innerHTML = '<textarea placeholder="Add note..."></textarea>';
                imgCell.appendChild(noteBox);
            });

            row.addEventListener('mouseleave', (e) => {
                const box = imgCell.querySelector('.note-box');
                if (box) box.remove();
            });
        });
    }

    // Initial setup
    setupNoteBoxes();

    // Handle dynamic content
    new MutationObserver(() => {
        setupNoteBoxes();
    }).observe(document.body, { childList: true, subtree: true });
});
