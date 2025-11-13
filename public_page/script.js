const WORKER_URL = 'https://ai-faceswap-backend.chungminhtu03.workers.dev';

// App state
let appState = {
    selfie: null,
    presets: [],
    selectedPreset: null,
    result: null,
    history: JSON.parse(localStorage.getItem('faceswap-history') || '[]'),
    selectedPresetIndex: -1
};

// Global variables
let selectedPreset = null;
let selfieImageUrl = null;
let collections = [];
let pendingPresetFiles = null;
let pendingPresetName = '';

// Initialize app
document.addEventListener('DOMContentLoaded', function() {
    setupDragAndDrop();
    loadCollectionsFromAPI();
    renderHistory();
    updateUI();
    setupKeyboardEvents();
    setupFileInputs();
});

// Setup keyboard events
function setupKeyboardEvents() {
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeModal('collections-modal');
            closeModal('preset-modal');
            closeModal('uploaded-presets-modal');
            closeModal('preset-name-modal');
        }
    });
}

// Setup file inputs
function setupFileInputs() {
    const selfieInput = document.getElementById('selfie-input');
    if (selfieInput) {
        selfieInput.addEventListener('change', function(e) {
            handleFiles(e.target.files);
        });
    }

    const presetInput = document.getElementById('preset-input');
    if (presetInput) {
        presetInput.addEventListener('change', function(e) {
            handlePresetFiles(e.target.files);
        });
    }

    // Listen to preset name input changes
    const presetNameInput = document.getElementById('preset-name-input');
    if (presetNameInput) {
        presetNameInput.addEventListener('input', function() {
            updateUploadButtonState();
        });
    }
}

// Trigger file input
function triggerFileInput(inputId) {
    const input = document.getElementById(inputId);
    if (input) {
        input.click();
    }
}

// Setup drag and drop
function setupDragAndDrop() {
    const selfieZone = document.getElementById('selfie-upload');
    if (!selfieZone) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        selfieZone.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        selfieZone.addEventListener(eventName, () => selfieZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        selfieZone.addEventListener(eventName, () => selfieZone.classList.remove('dragover'), false);
    });

    selfieZone.addEventListener('drop', function(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles(files);
    }, false);

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }
}

// Handle selfie file upload
async function handleFiles(files) {
    if (files.length > 0) {
        const file = files[0];
        if (validateFile(file)) {
            try {
                // Show preview
                const reader = new FileReader();
                reader.onload = function(e) {
                    const preview = document.getElementById('selfie-preview');
                    const uploadZone = document.getElementById('selfie-upload');
                    if (preview) {
                        preview.innerHTML = `<img src="${e.target.result}" alt="Your selfie">`;
                        preview.style.display = 'block';
                    }
                    if (uploadZone) {
                        uploadZone.style.display = 'none';
                    }
                };
                reader.readAsDataURL(file);

                // Get upload URL
                const uploadUrlResponse = await fetch(`${WORKER_URL}/upload-url`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: `selfie/${file.name}`,
                        type: 'selfie'
                    })
                });

                if (!uploadUrlResponse.ok) {
                    throw new Error('Failed to get upload URL');
                }

                const uploadData = await uploadUrlResponse.json();

                // Upload file
                const uploadResponse = await fetch(uploadData.uploadUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': file.type },
                    body: file
                });

                if (!uploadResponse.ok) {
                    throw new Error('Upload failed');
                }

                const uploadResult = await uploadResponse.json();
                appState.selfie = uploadResult.url;
                selfieImageUrl = uploadResult.url;

                updateUI();
                updateProgress();
                console.log('Selfie uploaded successfully');

            } catch (error) {
                console.error('Failed to upload selfie:', error);
            }
        }
    }
}

// Handle preset files selection
function handlePresetFiles(files) {
    if (files.length > 0) {
        const validFiles = Array.from(files).filter(validateFile);
        if (validFiles.length === 0) {
            console.error('No valid files selected');
            return;
        }

        pendingPresetFiles = validFiles;

        const fileInfo = document.getElementById('selected-files-info');
        if (fileInfo) {
            fileInfo.textContent = `${validFiles.length} file${validFiles.length > 1 ? 's' : ''} selected`;
        }

        updateUploadButtonState();
    }
}

// Update upload button state based on files and name
function updateUploadButtonState() {
    const uploadBtn = document.getElementById('upload-btn');
    const nameInput = document.getElementById('preset-name-input');
    
    if (uploadBtn) {
        const hasFiles = pendingPresetFiles && pendingPresetFiles.length > 0;
        const hasName = nameInput && nameInput.value.trim().length > 0;
        const shouldEnable = hasFiles && hasName;
        uploadBtn.disabled = !shouldEnable;
        console.log('Upload button state:', { hasFiles, hasName, shouldEnable, disabled: uploadBtn.disabled });
    }
}

// Validate file
function validateFile(file) {
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (!validTypes.includes(file.type)) {
        console.error('Please select a valid image file (JPG, PNG, WebP)');
        return false;
    }

    if (file.size > maxSize) {
        console.error('File size must be less than 10MB');
        return false;
    }

    return true;
}

// Load collections from API
async function loadCollectionsFromAPI() {
    try {
        console.log('Loading collections from:', `${WORKER_URL}/presets`);
        const response = await fetch(`${WORKER_URL}/presets`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('Collections API response:', data);

        if (data.preset_collections) {
            collections = data.preset_collections.map(collection => ({
                id: collection.id,
                name: collection.name,
                count: collection.images ? collection.images.length : 0,
                thumbnail: collection.images && collection.images.length > 0 ? collection.images[0].image_url : '',
                images: collection.images || []
            }));
            console.log('Loaded collections:', collections.length);
        } else {
            collections = [];
        }

        renderCollections();
    } catch (error) {
        console.error('Failed to load collections:', error);
        collections = [];
        renderCollections();
    }
}

// Render collections
function renderCollections() {
    const grid = document.getElementById('collections-grid');
    if (!grid) return;

    if (collections.length === 0) {
        grid.innerHTML = '<div style="grid-column: span 3; text-align: center; padding: 40px; color: #999;">No collections available</div>';
        return;
    }

    grid.innerHTML = collections.map(collection => {
        let imageUrl = collection.thumbnail;
        if (imageUrl && imageUrl.includes('/upload-proxy/')) {
            imageUrl = imageUrl.replace('/upload-proxy/', '/r2/');
        }

        return `
            <div class="collection-card" onclick="openPresetModal('${collection.id}')">
                <img src="${imageUrl}" alt="${collection.name}" class="collection-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'100\' height=\'100\'%3E%3Crect fill=\'%23ddd\' width=\'100\' height=\'100\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' text-anchor=\'middle\' dy=\'.3em\' fill=\'%23999\'%3ENo Image%3C/text%3E%3C/svg%3E';">
                <div class="collection-info">
                    <div class="collection-name">${collection.name}</div>
                    <div class="collection-count">${collection.count} images</div>
                </div>
            </div>
        `;
    }).join('');
}

// Open collections modal
function openCollectionsModal() {
    const modal = document.getElementById('collections-modal');
    if (modal) {
        modal.classList.add('show');
    }
}

// Open preset modal
function openPresetModal(collectionId) {
    const collection = collections.find(c => c.id == collectionId);
    if (!collection) return;

    const modalTitle = document.getElementById('preset-modal-title');
    if (modalTitle) {
        modalTitle.textContent = `Choose from ${collection.name}`;
    }

    renderPresets(collection.images);
    closeModal('collections-modal');
    
    const presetModal = document.getElementById('preset-modal');
    if (presetModal) {
        presetModal.classList.add('show');
    }
}

// Render presets in modal
function renderPresets(images) {
    const grid = document.getElementById('preset-grid');
    if (!grid) return;

    grid.innerHTML = images.map((imageUrl, index) => {
        let displayUrl = imageUrl;
        if (displayUrl.includes('/upload-proxy/')) {
            displayUrl = displayUrl.replace('/upload-proxy/', '/r2/');
        }

        return `
            <div class="preset-item ${appState.selectedPresetIndex === index ? 'selected' : ''}"
                 onclick="selectPresetItem(${index})">
                <img src="${displayUrl}" alt="Preset ${index + 1}" class="preset-image">
            </div>
        `;
    }).join('');
}

// Select preset item
function selectPresetItem(index) {
    appState.selectedPresetIndex = index;
    document.querySelectorAll('.preset-item').forEach((item, i) => {
        item.classList.toggle('selected', i === index);
    });
}

// Select preset and close modal
function selectPresetAndClose() {
    const presetModal = document.getElementById('preset-modal');
    if (!presetModal) return;

    const collection = collections.find(c => {
        const title = document.getElementById('preset-modal-title');
        return title && title.textContent.includes(c.name);
    });

    if (collection && appState.selectedPresetIndex >= 0 && collection.images[appState.selectedPresetIndex]) {
        const imageUrl = collection.images[appState.selectedPresetIndex];
        appState.selectedPreset = imageUrl;
        selectedPreset = {
            id: `preset_${collection.id}_${appState.selectedPresetIndex}`,
            name: collection.name,
            image_url: imageUrl
        };

        updateUI();
        updateProgress();
        closeModal('preset-modal');
        appState.selectedPresetIndex = -1;
    }
}

// Show preset upload modal
function showPresetUploadModal() {
    pendingPresetFiles = null;
    pendingPresetName = '';
    const nameInput = document.getElementById('preset-name-input');
    const fileInfo = document.getElementById('selected-files-info');
    
    if (nameInput) {
        nameInput.value = '';
    }
    if (fileInfo) fileInfo.textContent = '';

    const modal = document.getElementById('preset-name-modal');
    if (modal) {
        modal.classList.add('show');
    }

    // Update button state after modal is shown
    setTimeout(() => {
        updateUploadButtonState();
    }, 100);
}

// Confirm preset upload
function confirmPresetUpload() {
    const presetName = document.getElementById('preset-name-input')?.value.trim();
    if (!presetName) {
        alert('Please enter a preset collection name');
        return;
    }

    if (!pendingPresetFiles || pendingPresetFiles.length === 0) {
        alert('Please select image files first');
        return;
    }

    pendingPresetName = presetName;
    closeModal('preset-name-modal');
    uploadPresetFiles();
}

// Cancel preset upload
function cancelPresetUpload() {
    pendingPresetFiles = null;
    pendingPresetName = '';
    const nameInput = document.getElementById('preset-name-input');
    const fileInfo = document.getElementById('selected-files-info');
    const uploadBtn = document.getElementById('upload-btn');
    
    if (nameInput) nameInput.value = '';
    if (fileInfo) fileInfo.textContent = '';
    if (uploadBtn) uploadBtn.disabled = true;

    closeModal('preset-name-modal');
}

// Upload preset files
async function uploadPresetFiles() {
    if (!pendingPresetFiles || pendingPresetFiles.length === 0) return;

    appState.presets = [];

    for (let i = 0; i < pendingPresetFiles.length; i++) {
        const file = pendingPresetFiles[i];
        try {
            const originalName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
            const timestamp = Date.now();
            const randomStr = Math.random().toString(36).substring(2, 15);
            const extension = originalName.split('.').pop() || 'jpg';
            const filename = `preset-${timestamp}-${i}-${randomStr}.${extension}`;

            const presetName = pendingPresetFiles.length === 1
                ? (pendingPresetName || originalName.replace(/\.[^/.]+$/, ''))
                : `${pendingPresetName} ${i + 1}`;

            const uploadUrlResponse = await fetch(`${WORKER_URL}/upload-url`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, type: 'preset' })
            });

            if (!uploadUrlResponse.ok) continue;

            const { uploadUrl } = await uploadUrlResponse.json();
            const encodedPresetName = btoa(unescape(encodeURIComponent(presetName)));

            const uploadResponse = await fetch(uploadUrl, {
                method: 'PUT',
                body: file,
                headers: {
                    'Content-Type': file.type,
                    'X-Preset-Name': encodedPresetName,
                    'X-Preset-Name-Encoded': 'base64'
                }
            });

            if (!uploadResponse.ok) continue;

            const uploadResult = await uploadResponse.json();
            appState.presets.push({
                url: uploadResult.url,
                name: presetName,
                index: i
            });

            if (i === 0) {
                appState.selectedPreset = uploadResult.url;
            }

        } catch (error) {
            console.error(`Failed to upload ${file.name}:`, error);
        }
    }

    pendingPresetFiles = null;
    pendingPresetName = '';

    updateUI();
    updateProgress();

    if (appState.presets.length > 0) {
        await loadCollectionsFromAPI();
        if (appState.presets.length > 1) {
            openUploadedPresetsModal();
        }
    }
}

// Open uploaded presets modal
function openUploadedPresetsModal() {
    if (appState.presets.length === 0) return;

    renderUploadedPresets();
    const modal = document.getElementById('uploaded-presets-modal');
    if (modal) {
        modal.classList.add('show');
    }
}

// Render uploaded presets
function renderUploadedPresets() {
    const grid = document.getElementById('uploaded-preset-grid');
    if (!grid) return;

    grid.innerHTML = appState.presets.map((preset, index) => `
        <div class="preset-item ${appState.selectedPresetIndex === index ? 'selected' : ''}"
             onclick="selectPresetItem(${index})">
            <img src="${preset.url}" alt="${preset.name}" class="preset-image">
        </div>
    `).join('');
}

// Confirm preset selection
function confirmPresetSelection() {
    if (appState.selectedPresetIndex >= 0 && appState.presets[appState.selectedPresetIndex]) {
        const preset = appState.presets[appState.selectedPresetIndex];
        appState.selectedPreset = preset.url;
        selectedPreset = {
            id: `uploaded_${preset.index}`,
            name: preset.name,
            image_url: preset.url
        };

        updateUI();
        updateProgress();
        closeModal('uploaded-presets-modal');
        appState.selectedPresetIndex = -1;
    }
}

// Close modal
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
    }
}

// Update UI
function updateUI() {
    // Update selfie
    const selfiePreview = document.getElementById('selfie-preview');
    const selfieUpload = document.getElementById('selfie-upload');
    const selfieStatus = document.getElementById('selfie-status');

    if (appState.selfie) {
        if (selfiePreview) {
            selfiePreview.innerHTML = `<img src="${appState.selfie}" alt="Your selfie">`;
            selfiePreview.style.display = 'block';
        }
        if (selfieUpload) selfieUpload.style.display = 'none';
        if (selfieStatus) {
            selfieStatus.textContent = 'Selected';
            selfieStatus.style.color = '#28a745';
        }
    } else {
        if (selfiePreview) selfiePreview.style.display = 'none';
        if (selfieUpload) selfieUpload.style.display = 'flex';
        if (selfieStatus) {
            selfieStatus.textContent = 'Not selected';
            selfieStatus.style.color = '#666';
        }
    }

    // Update preset
    const presetPreview = document.getElementById('preset-preview');
    const presetOptions = document.querySelector('.preset-options');
    const presetStatus = document.getElementById('preset-status');
    const browseUploadedBtn = document.getElementById('browse-uploaded-btn');

    if (appState.selectedPreset) {
        if (presetPreview) {
            presetPreview.innerHTML = `<img src="${appState.selectedPreset}" alt="Selected preset">`;
            presetPreview.style.display = 'block';
        }
        if (presetOptions) presetOptions.style.display = 'none';
        if (browseUploadedBtn) browseUploadedBtn.style.display = 'none';
        if (presetStatus) {
            presetStatus.textContent = 'Selected';
            presetStatus.style.color = '#28a745';
        }
    } else {
        if (presetPreview) presetPreview.style.display = 'none';
        if (presetOptions) presetOptions.style.display = 'grid';
        if (browseUploadedBtn) {
            browseUploadedBtn.style.display = appState.presets.length > 0 ? 'inline-block' : 'none';
        }
        if (presetStatus) {
            presetStatus.textContent = appState.presets.length > 0 ? `${appState.presets.length} uploaded` : 'Not selected';
            presetStatus.style.color = appState.presets.length > 0 ? '#007bff' : '#666';
        }
    }

    // Update result
    const resultPreview = document.getElementById('result-preview');
    const resultStatus = document.getElementById('result-status');

    if (appState.result) {
        if (resultPreview) {
            resultPreview.innerHTML = `<img src="${appState.result}" alt="Face swap result">`;
        }
        if (resultStatus) {
            resultStatus.textContent = 'Generated';
            resultStatus.style.color = '#28a745';
        }
    } else {
        if (resultPreview) {
            resultPreview.innerHTML = '<div style="padding: 60px; color: #999; font-style: italic;">Result will appear here after generation</div>';
        }
        if (resultStatus) {
            resultStatus.textContent = 'Waiting for generation';
            resultStatus.style.color = '#666';
        }
    }

    // Update generate button
    const generateBtn = document.getElementById('generate-btn');
    if (generateBtn) {
        generateBtn.disabled = !appState.selfie || !selectedPreset;
    }
}

// Update progress
function updateProgress() {
    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const step3 = document.getElementById('step3');

    if (step1) {
        step1.className = 'step ' + (appState.selfie ? 'completed' : 'active');
    }
    if (step2) {
        step2.className = 'step ' + (selectedPreset ? 'completed' : (appState.selfie ? 'active' : 'pending'));
    }
    if (step3) {
        step3.className = 'step ' + (appState.result ? 'completed' : (appState.selfie && selectedPreset ? 'active' : 'pending'));
    }
}

// Generate face swap
async function generateFaceSwap() {
    if (!appState.selfie || !selectedPreset) {
        console.warn('Please select both a selfie and preset image');
        return;
    }

    const loadingOverlay = document.getElementById('loading-overlay');
    const generateBtn = document.getElementById('generate-btn');

    if (loadingOverlay) loadingOverlay.classList.add('show');
    if (generateBtn) generateBtn.disabled = true;

    try {
        const response = await fetch(`${WORKER_URL}/faceswap`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                target_url: selectedPreset.image_url,
                source_url: appState.selfie,
                preset_id: selectedPreset.id,
                preset_name: selectedPreset.name
            })
        });

        const data = await response.json();

        if (data.Success && data.ResultImageUrl) {
            appState.result = data.ResultImageUrl;

            appState.history.unshift({
                selfie: appState.selfie,
                preset: appState.selectedPreset,
                resultUrl: data.ResultImageUrl,
                timestamp: new Date().toISOString()
            });

            appState.history = appState.history.slice(0, 20);
            localStorage.setItem('faceswap-history', JSON.stringify(appState.history));

            updateUI();
            updateProgress();
            renderHistory();
            console.log('Face swap generated successfully!');
        } else {
            console.error(data.Message || 'Failed to generate face swap');
        }

    } catch (error) {
        console.error('Face swap error:', error);
    } finally {
        if (loadingOverlay) loadingOverlay.classList.remove('show');
        if (generateBtn) generateBtn.disabled = false;
    }
}

// Render history
function renderHistory() {
    const grid = document.getElementById('history-grid');
    if (!grid) return;

    if (appState.history.length === 0) {
        grid.innerHTML = '<div style="grid-column: span 4; text-align: center; padding: 40px; color: #999;">No results yet. Generate your first face swap!</div>';
        return;
    }

    grid.innerHTML = appState.history.slice(0, 8).map((item, index) => `
        <div class="history-item" onclick="loadFromHistory(${index})">
            <img src="${item.resultUrl}" alt="Result ${index + 1}" class="history-image">
            <div class="history-overlay">
                ${new Date(item.timestamp).toLocaleDateString()}
            </div>
        </div>
    `).join('');
}

// Load from history
function loadFromHistory(index) {
    const item = appState.history[index];
    if (item) {
        appState.selfie = item.selfie;
        appState.selectedPreset = item.preset;
        appState.result = item.resultUrl;
        selfieImageUrl = item.selfie;
        selectedPreset = {
            id: 'history_preset',
            name: 'From History',
            image_url: item.preset
        };
        updateUI();
        updateProgress();
    }
}

// Reset app
function resetApp() {
    appState.selfie = null;
    appState.presets = [];
    appState.selectedPreset = null;
    appState.result = null;
    appState.selectedPresetIndex = -1;
    selectedPreset = null;
    selfieImageUrl = null;
    updateUI();
    updateProgress();
}

// Clear history
function clearHistory() {
    if (confirm('Are you sure you want to clear all history?')) {
        appState.history = [];
        localStorage.removeItem('faceswap-history');
        renderHistory();
    }
}

// Close image selection modal
function closeImageSelectionModal() {
    closeModal('preset-modal');
}

// Close preset modal
function closePresetModal() {
    closeModal('collections-modal');
}
