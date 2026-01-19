let currentPath = '';
let allItems = [];
let selectedItems = new Set();
let currentPage = 1;
const itemsPerPage = 50;
let searchQuery = '';

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeJsString(str) {
    return "'" + str.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function formatDate(date) {
    if (!date) return '-';
    const d = new Date(date);
    return d.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '-';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function getFileIcon(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    const icons = {
        'webp': '🖼️', 'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'svg': '🖼️',
        'pdf': '📕', 'doc': '📘', 'docx': '📘', 'xls': '📊', 'xlsx': '📊',
        'txt': '📄', 'md': '📝', 'json': '📋', 'xml': '📋',
        'zip': '📦', 'rar': '📦', 'tar': '📦', 'gz': '📦',
        'mp4': '🎬', 'avi': '🎬', 'mov': '🎬', 'mp3': '🎵', 'wav': '🎵',
        'html': '🌐', 'css': '🎨', 'js': '⚡', 'ts': '⚡',
        'folder': '📁'
    };
    return icons[ext] || '📄';
}

function getFileType(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    return ext.toUpperCase() || 'FILE';
}

async function loadPath(path, page = 1) {
    currentPath = path || '';
    currentPage = page;
    selectedItems.clear();
    document.getElementById('selectAll').checked = false;
    document.getElementById('fileList').innerHTML = '<div class="loading">Loading...</div>';
    document.getElementById('deleteBtn').disabled = true;
    
    try {
        const sortBy = document.getElementById('sortBy').value;
        const sortOrder = document.getElementById('sortOrder').value;
        const search = document.getElementById('searchBox').value.trim();
        const url = '/api/list?path=' + encodeURIComponent(currentPath) + 
                   '&page=' + currentPage + 
                   '&pageSize=' + itemsPerPage +
                   '&sortBy=' + encodeURIComponent(sortBy) +
                   '&sortOrder=' + encodeURIComponent(sortOrder) +
                   (search ? '&search=' + encodeURIComponent(search) : '');
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('HTTP ' + response.status + ': ' + response.statusText);
        }
        const data = await response.json();
        
        if (data.success) {
            console.log('[loadPath] Received', data.folders?.length || 0, 'folders and', data.files?.length || 0, 'files');
            allItems = [
                ...(data.folders || []).map(f => ({ 
                    name: typeof f === 'string' ? f : f.path, 
                    type: 'folder', 
                    path: typeof f === 'string' ? f : f.path, 
                    date: null 
                })),
                ...(data.files || []).map(f => ({ 
                    name: f.path || f, 
                    type: 'file', 
                    path: f.path || f, 
                    date: f.date ? new Date(f.date) : null, 
                    size: f.size || 0 
                }))
            ];
            console.log('[loadPath] Total allItems:', allItems.length, 'pagination:', data.pagination);
            updateBreadcrumb(currentPath);
            renderItems();
            renderPagination(data.pagination);
        } else {
            showMessage('error', 'Error: ' + (data.error || 'Unknown error'));
            document.getElementById('fileList').innerHTML = '<div class="loading">Error loading files</div>';
        }
    } catch (error) {
        showMessage('error', 'Error loading path: ' + error.message);
        document.getElementById('fileList').innerHTML = '<div class="loading">Error: ' + escapeHtml(error.message) + '</div>';
    }
}

function updateBreadcrumb(path) {
    const parts = path.split('/').filter(p => p);
    let html = '<a onclick="loadPath(\'\')">Root</a>';
    let current = '';
    parts.forEach(part => {
        current += (current ? '/' : '') + part;
        const escapedCurrent = escapeJsString(current);
        html += ' / <a onclick="loadPath(' + escapedCurrent + ')">' + escapeHtml(part) + '</a>';
    });
    document.getElementById('breadcrumb').innerHTML = html;
}

function applyFilter() {
    searchQuery = document.getElementById('searchBox').value.toLowerCase().trim();
    currentPage = 1;
    loadPath(currentPath, 1);
}

function applySort() {
    sortBy = document.getElementById('sortBy').value;
    sortOrder = document.getElementById('sortOrder').value;
    currentPage = 1;
    loadPath(currentPath, 1);
}

let paginationInfo = null;

function renderItems() {
    const pageItems = allItems;
    console.log('[renderItems] Showing', pageItems.length, 'items from server');
    
    let html = '<div class="table-header"><div></div><div>Name</div><div class="size">Size</div><div>Date</div><div class="type">Type</div></div>';
    
    pageItems.forEach(item => {
        const isSelected = selectedItems.has(item.path);
        const displayName = item.path.split('/').pop();
        const escapedPath = escapeJsString(item.path);
        const escapedDisplayName = escapeHtml(displayName);
        const dateStr = item.date ? formatDate(item.date) : '-';
        const sizeStr = item.size ? formatSize(item.size) : '-';
        const icon = item.type === 'folder' ? getFileIcon('folder') : getFileIcon(displayName);
        const fileType = item.type === 'folder' ? 'FOLDER' : getFileType(displayName);
        
        const rowClickHandler = item.type === 'folder' 
            ? 'navigateTo(' + escapedPath + ')' 
            : 'toggleSelect(' + escapedPath + ')';
        html += '<div class="table-row ' + item.type + (isSelected ? ' selected' : '') + '" onclick="' + rowClickHandler + '">';
        html += '<input type="checkbox" class="checkbox" ' + (isSelected ? 'checked' : '') + ' onclick="event.stopPropagation(); toggleSelect(' + escapedPath + ')">';
        html += '<div class="name">';
        html += '<span style="font-size: 18px; margin-right: 8px;">' + icon + '</span>';
        html += escapedDisplayName;
        html += '</div>';
        html += '<div class="size">' + escapeHtml(sizeStr) + '</div>';
        html += '<div class="date">' + escapeHtml(dateStr) + '</div>';
        html += '<div class="type">' + escapeHtml(fileType) + '</div>';
        html += '</div>';
    });
    
    if (pageItems.length === 0) {
        html = '<div class="loading">No items found</div>';
    }
    
    document.getElementById('fileList').innerHTML = html;
    updateDeleteButton();
}

function renderPagination(pagination) {
    if (!pagination) {
        document.getElementById('pagination').innerHTML = '';
        return;
    }
    
    paginationInfo = pagination;
    const { page, totalPages, totalItems, hasNext, hasPrev } = pagination;
    
    if (totalItems === 0) {
        document.getElementById('pagination').innerHTML = '';
        return;
    }
    
    if (totalItems <= itemsPerPage) {
        document.getElementById('pagination').innerHTML = '<span>' + totalItems + ' item' + (totalItems !== 1 ? 's' : '') + '</span>';
        return;
    }
    
    let html = '';
    html += '<button onclick="changePage(' + (page - 1) + ')" ' + (!hasPrev ? 'disabled' : '') + '>Previous</button>';
    html += '<span>Page ' + page + ' of ' + totalPages + ' (' + totalItems + ' items)</span>';
    html += '<button onclick="changePage(' + (page + 1) + ')" ' + (!hasNext ? 'disabled' : '') + '>Next</button>';
    
    document.getElementById('pagination').innerHTML = html;
}

function changePage(page) {
    if (paginationInfo && page >= 1 && page <= paginationInfo.totalPages) {
        loadPath(currentPath, page);
    }
}

function toggleSelect(path) {
    if (selectedItems.has(path)) {
        selectedItems.delete(path);
    } else {
        selectedItems.add(path);
    }
    document.getElementById('selectAll').checked = selectedItems.size === allItems.length && allItems.length > 0;
    renderItems();
}

function toggleSelectAll() {
    const checked = document.getElementById('selectAll').checked;
    if (checked) {
        allItems.forEach(item => selectedItems.add(item.path));
    } else {
        selectedItems.clear();
    }
    renderItems();
}

function navigateTo(path) {
    loadPath(path);
}

function updateDeleteButton() {
    document.getElementById('deleteBtn').disabled = selectedItems.size === 0;
}

async function deleteSelected() {
    if (selectedItems.size === 0) return;
    
    if (!confirm('Delete ' + selectedItems.size + ' selected item(s)? This cannot be undone.')) {
        return;
    }
    
    const files = [];
    const folders = [];
    
    selectedItems.forEach(path => {
        const item = allItems.find(i => i.path === path);
        if (item && item.type === 'file') {
            files.push(path);
        } else if (item && item.type === 'folder') {
            folders.push(path);
        }
    });
    
    try {
        const promises = [];
        if (files.length > 0) {
            promises.push(fetch('/api/delete/files', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files })
            }));
        }
        if (folders.length > 0) {
            promises.push(fetch('/api/delete/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folders })
            }));
        }
        
        if (promises.length > 0) {
            const results = await Promise.all(promises);
            const data = await Promise.all(results.map(r => r.json()));
            
            let success = true;
            let message = 'Deleted successfully';
            data.forEach(d => {
                if (!d.success) {
                    success = false;
                    message = 'Some deletions failed';
                }
            });
            
            showMessage(success ? 'success' : 'error', message);
            selectedItems.clear();
            await loadPath(currentPath);
        }
    } catch (error) {
        showMessage('error', 'Error deleting: ' + error.message);
    }
}

function refresh() {
    loadPath(currentPath);
}

function showMessage(type, text) {
    const msgDiv = document.getElementById('message');
    msgDiv.className = type;
    msgDiv.textContent = text;
    msgDiv.style.display = 'block';
    setTimeout(() => {
        msgDiv.style.display = 'none';
    }, 5000);
}

async function handleZipFileSelect() {
    const fileInput = document.getElementById('zipFileInput');
    const bucketInput = document.getElementById('uploadBucket');
    const prefixInput = document.getElementById('uploadPrefix');
    
    if (!fileInput.files || fileInput.files.length === 0) {
        return;
    }
    
    const file = fileInput.files[0];
    const bucket = bucketInput.value.trim();
    const prefix = prefixInput.value.trim();
    
    if (!file.name.toLowerCase().endsWith('.zip')) {
        showMessage('error', 'Please select a ZIP file');
        fileInput.value = '';
        return;
    }
    
    if (!bucket) {
        showMessage('error', 'Bucket name is required');
        return;
    }
    
    const formData = new FormData();
    formData.append('zipfile', file);
    formData.append('bucket', bucket);
    formData.append('prefix', prefix);
    
    showMessage('success', 'Uploading ZIP file...');
    const uploadBtn = document.getElementById('uploadZipBtn');
    if (uploadBtn) {
        uploadBtn.disabled = true;
        uploadBtn.textContent = 'Uploading...';
    }
    
    try {
        const response = await fetch('/api/upload/zip', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage('success', data.message || 'Upload successful');
            fileInput.value = '';
            setTimeout(() => {
                loadPath(currentPath);
            }, 1000);
        } else {
            showMessage('error', 'Upload failed: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        showMessage('error', 'Upload error: ' + error.message);
    } finally {
        if (uploadBtn) {
            uploadBtn.disabled = false;
            uploadBtn.textContent = 'Upload ZIP';
        }
    }
}

loadPath('');
