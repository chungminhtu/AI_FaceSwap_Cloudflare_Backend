# Static Docsify Documentation

This directory contains the API documentation that can be built as a fully static HTML file with working search functionality.

## Building Static Documentation

To generate a static HTML file with all content embedded and working search:

```bash
node build-static.js
```

This will create `index-static.html` which is a single, self-contained HTML file that:
- ✅ Contains all markdown content embedded
- ✅ Has working search functionality
- ✅ Works without a server (can be opened directly in browser)
- ✅ Can be deployed to any static hosting (Cloudflare Pages, GitHub Pages, etc.)

## Usage

### For Local Development

1. Use the regular `index.html` with Docsify server:
   ```bash
   docsify serve .
   ```

### For Static Hosting

1. Build the static version:
   ```bash
   node build-static.js
   ```

2. Deploy `index-static.html` to your static hosting:
   - **Cloudflare Pages**: Upload `index-static.html` and rename it to `index.html`
   - **GitHub Pages**: Commit `index-static.html` as `index.html`
   - **Any static host**: Just upload the HTML file

## How It Works

The static builder:
1. Reads all `.md` files in the directory
2. Embeds all content directly in the HTML
3. Pre-generates a search index
4. Overrides `fetch()` to serve content from memory
5. Works completely offline - no server needed!

## File Structure

```
docs/
├── index.html          # Regular Docsify (needs server)
├── index-static.html   # Static version (no server needed)
├── build-static.js     # Build script
├── _sidebar.md         # Sidebar navigation
└── *.md                # Documentation files
```

## Search Functionality

The static version includes a pre-generated search index that works client-side. Search will:
- Index all headings (H1, H2, H3)
- Index content text
- Work offline
- No external API calls needed

