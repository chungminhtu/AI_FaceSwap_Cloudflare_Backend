const fs = require('fs');
const path = require('path');

// Build a fully static Docsify site with embedded content and search
function buildStatic() {
  const docsDir = __dirname;
  const outputFile = path.join(docsDir, 'index.html');
  
  // Read all markdown files
  const files = {};
  const sidebarItems = [];
  
  fs.readdirSync(docsDir).forEach(file => {
    if (file.endsWith('.md') && file !== '_sidebar.md') {
      const content = fs.readFileSync(path.join(docsDir, file), 'utf8');
      const title = extractTitle(content);
      files[file] = content;
      sidebarItems.push({ file, title });
    }
  });
  
  // Generate sidebar from _sidebar.md or auto-generate from files
  let sidebarContent = '';
  if (fs.existsSync(path.join(docsDir, '_sidebar.md'))) {
    sidebarContent = fs.readFileSync(path.join(docsDir, '_sidebar.md'), 'utf8');
  } else {
    // Generate sidebar from files
    sidebarContent = sidebarItems.map(item => 
      `* [${item.title}](${item.file})`
    ).join('\n');
  }
  
  // Generate search index
  const searchIndex = buildSearchIndex(files);
  
  // Generate static HTML
  const html = generateStaticHTML(files, sidebarContent, searchIndex);
  
  fs.writeFileSync(outputFile, html, 'utf8');
  
  console.log('✅ Static documentation generated:', outputFile);
  console.log(`📄 ${Object.keys(files).length} markdown files embedded`);
  console.log(`🔍 ${searchIndex.length} search index entries`);
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'Untitled';
}

function generateSidebarFromAPI(files) {
  const apiFile = files['API_TONG_QUAN_VI.md'];
  if (!apiFile) {
    return sidebarItems.map(item => 
      `* [${item.title}](${item.file})`
    ).join('\n');
  }
  
  const lines = apiFile.split('\n');
  const sidebar = [];
  let inMobileAPIs = false;
  let mobileAPIs = [];
  let inAPIEndpoints = false;
  let currentCategory = '';
  
  sidebar.push('* [📚 Tổng quan API](API_TONG_QUAN_VI.md)');
  sidebar.push('');
  
  lines.forEach((line) => {
    const trimmed = line.trim();
    
    if (trimmed.includes('### APIs cần tích hợp với mobile (21 APIs)')) {
      inMobileAPIs = true;
      return;
    }
    
    if (inMobileAPIs && trimmed.match(/^\d+\.\s+(POST|GET|PUT|DELETE|PATCH|OPTIONS)/)) {
      const apiMatch = trimmed.match(/^\d+\.\s+(POST|GET|PUT|DELETE|PATCH|OPTIONS)\s+`(.+?)`(?:\s*\(.+?\))?\s*-\s*(.+)$/);
      if (apiMatch) {
        const method = apiMatch[1];
        const path = apiMatch[2];
        const description = apiMatch[3];
        mobileAPIs.push({ method, path, description });
      }
    }
    
    if (inMobileAPIs && trimmed.startsWith('### APIs không cần tích hợp')) {
      inMobileAPIs = false;
    }
    
    if (trimmed === '## API Endpoints (Chi tiết)') {
      inAPIEndpoints = true;
      return;
    }
    
    if (inAPIEndpoints) {
      const h3Match = trimmed.match(/^###\s+(\d+)\.\s+(.+)$/);
      const h4Match = trimmed.match(/^####\s+(\d+\.\d+)\.\s+(.+)$/);
      
      if (h3Match) {
        const categoryNum = h3Match[1];
        const categoryName = h3Match[2];
        currentCategory = categoryName;
        sidebar.push(`* **${categoryNum}. ${categoryName}**`);
      } else if (h4Match && currentCategory) {
        const endpointTitle = h4Match[2].replace(/`/g, '');
        const anchor = slugify(endpointTitle);
        sidebar.push(`  * [${endpointTitle}](API_TONG_QUAN_VI.md#${anchor})`);
      }
    }
  });
  
  let inSubSection = false;
  const subSectionItems = [];
  lines.forEach((line) => {
    const t = line.trim();
    if (t.startsWith('## 6. Thanh toán & Subscription')) {
      inSubSection = true;
      subSectionItems.push({ level: 2, title: '6. Thanh toán & Subscription (Google Play Billing)', raw: t });
      return;
    }
    if (inSubSection && t.startsWith('## ') && !t.startsWith('## 6.')) {
      inSubSection = false;
      return;
    }
    if (inSubSection && t.startsWith('### ')) {
      const title = t.replace(/^###\s+/, '');
      subSectionItems.push({ level: 3, title, raw: t });
    }
    if (inSubSection && t.startsWith('#### ')) {
      const title = t.replace(/^####\s+/, '').replace(/`/g, '').trim();
      subSectionItems.push({ level: 4, title, raw: t });
    }
  });

  if (mobileAPIs.length > 0) {
    const mobileSectionIndex = sidebar.findIndex(line => line.includes('📚 Tổng quan API'));
    const insertIndex = mobileSectionIndex + 2;

    sidebar.splice(insertIndex, 0, '* **APIs cần tích hợp với mobile (21 APIs)**');

    const anchorMap = {
      'POST /upload-url': '11-post-upload-url-typeselfie---upload-selfie',
      'POST /faceswap': '21-post-faceswap---face-swap',
      'POST /background': '22-post-background---ai-background',
      'POST /enhance': '23-post-enhance---ai-enhance',
      'POST /beauty': '24-post-beauty---ai-beauty',
      'POST /filter': '25-post-filter---ai-filter-styles',
      'POST /restore': '26-post-restore---ai-restore',
      'POST /aging': '27-post-aging---ai-aging',
      'POST /upscaler4k': '28-post-upscaler4k---ai-upscale-4k',
      'POST /profiles': '31-post-profiles---tạo-profile',
      'GET /profiles/{id}': '32-get-profilesid---lấy-profile',
      'GET /selfies': '44-get-selfies---liệt-kê-selfies',
      'GET /results': '46-get-results---liệt-kê-results',
      'DELETE /results/{id}': '47-delete-resultsid---xóa-result'
    };
    
    mobileAPIs.forEach((api, index) => {
      const pathKey = `${api.method} ${api.path.replace(/\(.+?\)/g, '').trim()}`;
      const anchor = anchorMap[pathKey] || slugify(`${api.method} ${api.path} - ${api.description}`);
      sidebar.splice(insertIndex + 1 + index, 0, `  * [${api.method} ${api.path} - ${api.description}](API_TONG_QUAN_VI.md#${anchor})`);
    });
    
    sidebar.splice(insertIndex + mobileAPIs.length + 1, 0, '');
  }

  if (subSectionItems.length > 0) {
    sidebar.push('* **💳 Thanh toán & Subscription**');
    subSectionItems.forEach((item) => {
      const anchor = slugify(item.title);
      const indent = item.level === 4 ? '    ' : item.level === 3 ? '  ' : '';
      sidebar.push(`${indent}* [${item.title}](API_TONG_QUAN_VI.md#${anchor})`);
    });
    sidebar.push('');
  }

  if (files['FCM_SETUP_COMPLETE_VI.md']) {
    sidebar.push('* [🔔 Push (FCM) – Setup & Endpoints](FCM_SETUP_COMPLETE_VI.md)');
  }
  
  return sidebar.join('\n');
}

function buildSearchIndex(files) {
  const index = [];
  
  Object.entries(files).forEach(([fileName, content]) => {
    const lines = content.split('\n');
    let currentSection = extractTitle(content);
    let lineNum = 0;
    
    lines.forEach(line => {
      lineNum++;
      const trimmed = line.trim();
      
      // Skip code blocks
      if (trimmed.startsWith('```')) return;
      
      // Extract headings
      const h1 = trimmed.match(/^#\s+(.+)$/);
      const h2 = trimmed.match(/^##\s+(.+)$/);
      const h3 = trimmed.match(/^###\s+(.+)$/);
      
      if (h1) {
        currentSection = h1[1];
        index.push({
          title: currentSection,
          heading: currentSection,
          text: trimmed,
          url: `#/${fileName}`,
          level: 1
        });
      } else if (h2) {
        const heading = h2[1];
        index.push({
          title: `${currentSection} - ${heading}`,
          heading: heading,
          text: trimmed,
          url: `#/${fileName}?id=${slugify(heading)}`,
          level: 2
        });
      } else if (h3) {
        const heading = h3[1];
        index.push({
          title: `${currentSection} - ${heading}`,
          heading: heading,
          text: trimmed,
          url: `#/${fileName}?id=${slugify(heading)}`,
          level: 3
        });
      } else if (trimmed.length > 10 && !trimmed.startsWith('|')) {
        // Index content (skip tables and short lines)
        const words = trimmed.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        if (words.length > 0) {
          index.push({
            title: currentSection,
            heading: currentSection,
            text: trimmed.substring(0, 150),
            url: `#/${fileName}`,
            level: 0
          });
        }
      }
    });
  });
  
  return index;
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function generateStaticHTML(files, sidebar, searchIndex) {
  const fileNames = Object.keys(files);
  const firstFile = fileNames[0] || 'README.md';
  
  let filesJS = Object.entries(files).map(([name, content]) => {
    return `${JSON.stringify(name)}: ${JSON.stringify(content)}`;
  }).join(',\n      ');
  filesJS = filesJS.replace(/<\/script>/gi, '\\u003c/script>');

  let sidebarJSON = JSON.stringify(sidebar);
  sidebarJSON = sidebarJSON.replace(/<\/script>/gi, '\\u003c/script>');
  
  return `<!--
  ⚠️ DO NOT EDIT THIS FILE ⚠️
  This file is auto-generated by build-static.js
  To make changes, edit the source files and run: node build-static.js
  Generated: ${new Date().toISOString()}
-->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Face Swap AI - API Documentation</title>
  <!-- Google Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@100;200;300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/docsify@4/lib/themes/buble.css">
  <style>
    * {
      font-family: 'Lexend Deca', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    :root {
      --theme-color: #3b82f6;
      --theme-color-dark: #2563eb;
      --sidebar-width: 380px;
      --content-max-width: 95%;
    }
    
    body {
      font-family: 'Lexend Deca', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-weight: 400;
    }
    
    .app-name-link img {
      max-width: 200px;
    }
    
    .sidebar {
      background: #ffffff;
      border-right: 1px solid #e5e7eb;
      width: var(--sidebar-width) !important;
    }
    
    .sidebar-toggle {
      display: none !important;
    }
    
    @media (max-width: 768px) {
      .sidebar {
        width: var(--sidebar-width) !important;
        transform: translateX(0) !important;
      }
    }
    
    .sidebar ul li a {
      color: #374151;
      font-weight: 400;
      font-family: 'Lexend Deca', sans-serif;
    }
    
    .sidebar ul li a:hover {
      color: var(--theme-color);
      background: rgba(59, 130, 246, 0.05);
    }
    
    .sidebar ul li.active > a {
      color: var(--theme-color);
      background: rgba(59, 130, 246, 0.1);
      border-left: 3px solid var(--theme-color);
      font-weight: 500;
    }
    
    .markdown-section {
      max-width: var(--content-max-width) !important;
      width: var(--content-max-width) !important;
      padding: 2rem 3rem;
    }
    
    @media (min-width: 1400px) {
      .markdown-section {
        max-width: 1400px !important;
        width: 1400px !important;
      }
    }
    
    .markdown-section h1 {
      color: #1f2937;
      border-bottom: 2px solid var(--theme-color);
      padding-bottom: 10px;
      font-weight: 600;
      font-family: 'Lexend Deca', sans-serif;
    }
    
    .markdown-section h2 {
      color: #374151;
      margin-top: 40px;
      font-weight: 600;
      font-family: 'Lexend Deca', sans-serif;
    }
    
    .markdown-section h3 {
      color: #4b5563;
      margin-top: 30px;
      font-weight: 500;
      font-family: 'Lexend Deca', sans-serif;
    }
    
    .markdown-section p,
    .markdown-section li {
      font-family: 'Lexend Deca', sans-serif;
      font-weight: 400;
      line-height: 1.7;
      color: #4b5563;
    }
    
    .markdown-section code {
      font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace !important;
      background: #f3f4f6;
      color: #dc2626;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
      font-weight: 400;
    }
    
    .markdown-section pre {
      background: #1f2937;
      border-left: 4px solid var(--theme-color);
      border-radius: 6px;
      padding: 1.5rem;
      overflow-x: auto;
    }
    
    .markdown-section pre code {
      font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace !important;
      background: transparent;
      color: #e5e7eb;
      padding: 0;
      font-size: 0.9em;
      font-weight: 400;
      line-height: 1.6;
    }
    
    .markdown-section blockquote {
      border-left: 4px solid var(--theme-color);
      background: rgba(59, 130, 246, 0.05);
      padding: 1rem 1.5rem;
      margin: 1.5rem 0;
      border-radius: 4px;
    }
    
    .markdown-section blockquote p {
      color: #4b5563;
      margin: 0;
    }
    
    .app-name {
      font-size: 24px;
      font-weight: 600;
      color: var(--theme-color);
      font-family: 'Lexend Deca', sans-serif;
    }
    
    .cover {
      background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 50%, #bfdbfe 100%);
    }
    
    .cover-main {
      color: #1f2937;
    }
    
    .cover-main h1 {
      color: var(--theme-color);
      font-family: 'Lexend Deca', sans-serif;
      font-weight: 600;
    }
    
    .cover-main p {
      color: #4b5563;
      font-family: 'Lexend Deca', sans-serif;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
    }
    
    table th,
    table td {
      padding: 0.75rem;
      border: 1px solid #e5e7eb;
      text-align: left;
      font-family: 'Lexend Deca', sans-serif;
    }
    
    table th {
      background: #f9fafb;
      font-weight: 600;
      color: #374151;
    }
    
    table tr:hover {
      background: #f9fafb;
    }
    
    .search input {
      font-family: 'Lexend Deca', sans-serif;
    }
  </style>
</head>
<body>
  <div id="app">Loading...</div>
  
  <script>
    // Embedded markdown content
    window.__staticDocs = {
      ${filesJS}
    };
    
    // Embedded sidebar
    window.__staticSidebar = ${sidebarJSON};
    
    // Pre-generated search index
    window.__staticSearchIndex = ${JSON.stringify(searchIndex).replace(/<\/script>/gi, '\\u003c/script>')};
    
    // Configure Docsify
    window.$docsify = {
      name: 'Face Swap AI API',
      repo: '',
      loadSidebar: true,
      subMaxLevel: 4,
      auto2top: true,
      homepage: '${firstFile}',
      coverpage: false,
      search: {
        maxAge: 86400000,
        paths: ${JSON.stringify(fileNames)},
        placeholder: 'Tìm kiếm...',
        noData: 'Không tìm thấy kết quả',
        depth: 6
      },
      notFoundPage: true,
      executeScript: true,
      markdown: {
        renderer: {
          code: function(code, lang) {
            if (lang === 'mermaid') {
              return '<div class="mermaid">' + code + '</div>';
            }
            return this.origin.code.apply(this, arguments);
          }
        }
      },
      pagination: {
        previousText: 'Trước',
        nextText: 'Tiếp',
        crossChapter: true,
        crossChapterText: true,
      },
      plugins: [
        function(hook, vm) {
          // Override sidebar loading
          hook.beforeEach(function(html) {
            return html;
          });
          
          hook.mounted(function() {
            // Inject sidebar content
            const sidebarEl = document.querySelector('.sidebar');
            if (sidebarEl && window.__staticSidebar) {
              // Docsify will load sidebar, but we can pre-populate it
            }
            
            // Ensure sidebar is expanded by default
            setTimeout(() => {
              const sidebar = document.querySelector('.sidebar');
              const app = document.querySelector('#app');
              if (sidebar && app) {
                sidebar.style.transform = 'translateX(0)';
                sidebar.style.display = 'block';
                app.classList.remove('close');
              }
            }, 100);
          });
          
          // Override fetch to serve from embedded content
          const originalFetch = window.fetch;
          window.fetch = function(url, options) {
            if (typeof url === 'string') {
              // Handle markdown files
              if (url.endsWith('.md') || url.includes('.md')) {
                const fileName = url.split('/').pop().split('?')[0];
                if (window.__staticDocs[fileName]) {
                  return Promise.resolve(new Response(
                    window.__staticDocs[fileName],
                    { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }
                  ));
                }
              }
              // Handle sidebar
              if (url.includes('_sidebar.md') || url.endsWith('_sidebar')) {
                return Promise.resolve(new Response(
                  window.__staticSidebar,
                  { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }
                ));
              }
            }
            return originalFetch.apply(this, arguments);
          };
          
          // Render mermaid diagrams after page load
          hook.doneEach(function() {
            var els = document.querySelectorAll('.mermaid');
            els.forEach(function(el) {
              if (el.getAttribute('data-processed')) return;
              try { mermaid.run({ nodes: [el] }); } catch(e) { console.warn('Mermaid render error:', e); }
            });
          });

          // Inject search index when search plugin loads
          hook.doneEach(function() {
            if (window.Docsify && window.Docsify.util && window.__staticSearchIndex) {
              // Try to set search index
              setTimeout(() => {
                const searchPlugin = window.Docsify.dom.find('.search input');
                if (searchPlugin && !window.__searchIndexSet) {
                  // Store index globally for search plugin
                  window.DocsifySearchIndex = window.__staticSearchIndex;
                  window.__searchIndexSet = true;
                }
              }, 100);
            }
          });
        },
        // Custom search plugin that uses pre-generated index
        function(hook, vm) {
          hook.ready(function() {
            if (window.__staticSearchIndex) {
              // Override search functionality
              const searchInput = document.querySelector('.search input');
              if (searchInput) {
                searchInput.addEventListener('input', function(e) {
                  const query = e.target.value.toLowerCase().trim();
                  if (query.length < 2) return;
                  
                  const results = window.__staticSearchIndex.filter(item => {
                    const searchText = (item.title + ' ' + item.text).toLowerCase();
                    return searchText.includes(query);
                  });
                  
                  // Display results (simplified - Docsify will handle UI)
                  console.log('Search results:', results.length);
                });
              }
            }
          });
        }
      ]
    };
  </script>
  
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>mermaid.initialize({ startOnLoad: false, theme: 'default' });</script>
  <script src="https://cdn.jsdelivr.net/npm/docsify@4"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify/lib/plugins/search.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify/lib/plugins/pagination.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify/lib/plugins/emoji.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify/lib/plugins/external-script.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/docsify/lib/plugins/zoom-image.min.js"></script>
</body>
</html>`;
}

// Run builder
buildStatic();

