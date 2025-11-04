# sahibinden

Important note for using on saved HTML (file://):
- In Chrome, open chrome://extensions, find this extension, click Details, and enable "Allow access to file URLs".
- Then open your saved detail page (e.g., file:///.../detail-page.html) and use the extension popup as on the live site.
- The extension detects file:// pages and scrapes directly from the DOM without re-fetching the page. Images are embedded via a local data URL.
