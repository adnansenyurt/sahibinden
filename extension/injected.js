function initializeNotesFeature() {
  console.log('Initializing notes feature');
  
  document.querySelectorAll('tr[data-id]').forEach(row => {
    const adId = row.dataset.id;
    const imgCell = row.querySelector('td:first-child');
    if (!imgCell) return;

    imgCell.style.position = 'relative';
    
    row.addEventListener('mouseenter', () => {
      console.log('Mouse entered', adId);
      const noteBox = document.createElement('div');
      noteBox.style.cssText = `
        position: absolute;
        left: -220px;
        top: 0;
        width: 200px;
        height: 100%;
        background: white;
        border: 1px solid #ccc;
        z-index: 999999;
        padding: 8px;
      `;
      noteBox.innerHTML = '<textarea style="width:100%;height:100%"></textarea>';
      imgCell.appendChild(noteBox);
    });

    row.addEventListener('mouseleave', () => {
      const noteBox = imgCell.querySelector('div');
      if (noteBox) noteBox.remove();
    });
  });
}

initializeNotesFeature();
