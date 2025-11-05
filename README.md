# sahibinden

Important note for using on saved HTML (file://):
- In Chrome, open chrome://extensions, find this extension, click Details, and enable "Allow access to file URLs".
- Saved detail pages: open your saved detail page (e.g., file:///.../detail-page.html) and use the extension popup as on the live site. The extension detects file:// detail pages and scrapes directly from the DOM without re-fetching the page. Images are embedded via a local data URL.
- Saved listing pages: open your saved listing (search results) HTML (e.g., file:///.../listing.html). The extension will scrape only the fields available in the listing rows (title, price, location, image, id, URL). It will NOT fetch or process detail pages in the background for file:// listings.
