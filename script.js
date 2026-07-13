const API_URL = 'https://script.google.com/macros/s/AKfycbzlsQBNPEfOPqMx1Ka03sWb4OUYGa5o3sqSaOLyknxdMm8hlXD9E3qPa9OeZ5krKB28Rw/exec';

let modelsLoaded = false;
let existingNames = [];
let storedDescriptors = []; // [{name: "Budi", descriptor: [...]}, ...]
let currentFaceDescriptor = null;
let currentFaceImage = null;
let currentFileName = '';
let isProcessingBatch = false;
let batchQueue = [];
let batchIndex = 0;
let batchResults = { saved: 0, skipped: 0, errors: 0 };
let stream = null;
let testStream = null;
let localData = [];
let recognitionInterval = null;

// ==================== LOADING ====================
function setLoading(status, percent, errorMsg) {
    document.getElementById('loadingStatus').textContent = status;
    document.getElementById('loadingBarFill').style.width = percent + '%';
    if (errorMsg) {
        document.getElementById('loadingError').textContent = errorMsg;
        document.getElementById('loadingError').classList.add('active');
        document.getElementById('retryBtn').classList.add('active');
    }
}

function hideLoading() {
    document.getElementById('loadingScreen').classList.add('hidden');
    document.getElementById('appContainer').style.display = 'block';
}

// ==================== INIT ====================
async function initApp() {
    document.getElementById('loadingError').classList.remove('active');
    document.getElementById('retryBtn').classList.remove('active');

    setLoading('Loading face detection models...', 20);
    try {
        const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        modelsLoaded = true;
    } catch (err) {
        setLoading('Failed to load models', 0, 'Check your internet connection and retry. Error: ' + err.message);
        return;
    }

    setLoading('Connecting to Google Sheets...', 60);
    try {
        const response = await fetch(API_URL + '?action=names', { method: 'GET' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        if (data.status === 'ok') {
            existingNames = data.names || [];
            updateConnectionBadge(true, existingNames.length);
            log('Connected. ' + existingNames.length + ' students in sheet.', 'success');
        } else {
            throw new Error(data.message || 'Unknown error');
        }
    } catch (err) {
        setLoading('Connection failed', 60, 'Could not connect to Google Sheets. ' + err.message + ' The app will work offline. Data will be saved locally and can be exported later.');
        updateConnectionBadge(false, 0);
        log('Sheet offline. Working in local mode.', 'warning');
    }

    setLoading('Ready!', 100);
    setTimeout(hideLoading, 500);
}

window.addEventListener('DOMContentLoaded', initApp);

// ==================== CONNECTION ====================
function updateConnectionBadge(connected, count) {
    const badge = document.getElementById('connBadge');
    if (connected) {
        badge.className = 'status-badge status-connected';
        badge.innerHTML = '<span style="color: #22c55e;">●</span> <span id="connText">' + count + ' students</span>';
    } else {
        badge.className = 'status-badge status-disconnected';
        badge.innerHTML = '<span style="color: #ef4444;">●</span> <span id="connText">Offline mode</span>';
    }
}

// ==================== NAVIGATION ====================
function showMainMode() {
    stopRecognition();
    document.getElementById('uploadSection').classList.remove('active');
    document.getElementById('cameraSection').classList.remove('active');
    document.getElementById('testSection').classList.remove('active');
    document.getElementById('mainSection').classList.add('active');
}

function showUploadMode() {
    if (!modelsLoaded) { showToast('Models still loading...', 'info'); return; }
    document.getElementById('mainSection').classList.remove('active');
    document.getElementById('uploadSection').classList.add('active');
}

function showCameraMode() {
    if (!modelsLoaded) { showToast('Models still loading...', 'info'); return; }
    document.getElementById('mainSection').classList.remove('active');
    document.getElementById('cameraSection').classList.add('active');
    startCamera();
}

function showTestMode() {
    if (!modelsLoaded) { showToast('Models still loading...', 'info'); return; }
    document.getElementById('mainSection').classList.remove('active');
    document.getElementById('testSection').classList.add('active');
    startRecognitionCamera();
}

// ==================== BATCH UPLOAD ====================
async function handleFileSelect(event) {
    const files = Array.from(event.target.files);
    if (files.length === 0) return;
    if (files.length > 20) { showToast('Limited to 20 photos.', 'warning'); files.length = 20; }

    batchQueue = files;
    batchIndex = 0;
    batchResults = { saved: 0, skipped: 0, errors: 0 };
    isProcessingBatch = true;

    document.getElementById('uploadProgress').classList.add('active');
    updateProgress();
    log('Batch: ' + files.length + ' photos', 'info');
    await processNextBatchItem();
}

async function processNextBatchItem() {
    if (batchIndex >= batchQueue.length) { finishBatch(); return; }

    const file = batchQueue[batchIndex];
    currentFileName = file.name;
    updateProgress();

    try {
        const img = await loadImage(file);
        const result = await detectFace(img);

        if (!result) { log('No face: ' + file.name, 'error'); batchResults.errors++; nextBatchItem(); return; }
        if (result.multiple) { log('Multiple faces: ' + file.name + '. Skipped.', 'warning'); batchResults.errors++; nextBatchItem(); return; }

        currentFaceDescriptor = result.descriptor;
        currentFaceImage = result.canvas;
        showNameDialog(file.name);
    } catch (err) {
        log(file.name + ': ' + err.message, 'error');
        batchResults.errors++;
        nextBatchItem();
    }
}

function nextBatchItem() { batchIndex++; if (isProcessingBatch) processNextBatchItem(); }

function finishBatch() {
    isProcessingBatch = false;
    document.getElementById('uploadProgress').classList.remove('active');
    log('Done! Saved: ' + batchResults.saved + ', Skipped: ' + batchResults.skipped + ', Errors: ' + batchResults.errors, 'success');
    showToast('Complete: ' + batchResults.saved + ' saved', 'success');
    document.getElementById('fileInput').value = '';
}

function updateProgress() {
    const pct = batchQueue.length > 0 ? ((batchIndex / batchQueue.length) * 100).toFixed(0) : 0;
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressText').textContent = batchIndex + ' / ' + batchQueue.length + ' processed';
}

// ==================== ENROLLMENT CAMERA ====================
async function startCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
});
        const video = document.getElementById('videoElement');
        video.srcObject = stream;
        video.addEventListener('play', drawFaceOverlay);
        log('Camera on', 'info');
    } catch (err) {
        log('Camera error: ' + err.message, 'error');
        showToast('Cannot access camera.', 'error');
    }
}

function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    const video = document.getElementById('videoElement');
    video.srcObject = null;
    video.removeEventListener('play', drawFaceOverlay);
    const canvas = document.getElementById('cameraCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

async function drawFaceOverlay() {
    const video = document.getElementById('videoElement');
    const canvas = document.getElementById('cameraCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    const detect = async () => {
        if (video.paused || video.ended) return;
        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }));
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        detections.forEach(det => {
            const box = det.box;
            const isMulti = detections.length > 1;
            ctx.strokeStyle = isMulti ? '#ef4444' : '#22c55e';
            ctx.lineWidth = 3;
            ctx.strokeRect(box.x, box.y, box.width, box.height);
            ctx.fillStyle = isMulti ? '#ef4444' : '#22c55e';
            ctx.font = 'bold 14px sans-serif';
            ctx.fillText(isMulti ? 'Multiple faces!' : 'Face OK', box.x, box.y - 8);
        });
        requestAnimationFrame(detect);
    };
    detect();
}

async function capturePhoto() {
    const video = document.getElementById('videoElement');
    if (!video.srcObject) { showToast('Camera not active', 'error'); return; }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    try {
        const result = await detectFace(canvas);
        if (!result) { showToast('No face found. Try again.', 'error'); return; }
        if (result.multiple) { showToast('Multiple faces detected.', 'error'); return; }

        currentFaceDescriptor = result.descriptor;
        currentFaceImage = result.canvas;
        currentFileName = 'Camera';
        showNameDialog('Camera');
    } catch (err) { showToast('Error: ' + err.message, 'error'); }
}

// ==================== LIVE RECOGNITION (TEST MODULE) ====================
async function startRecognitionCamera() {
    try {
        testStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
});
        const video = document.getElementById('testVideoElement');
        video.srcObject = testStream;
        video.addEventListener('play', startLiveRecognition);
        log('Recognition camera on', 'info');
    } catch (err) {
        log('Recognition camera error: ' + err.message, 'error');
        showToast('Cannot access camera.', 'error');
    }
}

function stopRecognition() {
    if (recognitionInterval) { clearInterval(recognitionInterval); recognitionInterval = null; }
    if (testStream) { testStream.getTracks().forEach(t => t.stop()); testStream = null; }
    const video = document.getElementById('testVideoElement');
    video.srcObject = null;
    video.removeEventListener('play', startLiveRecognition);
    const canvas = document.getElementById('testCameraCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

async function startLiveRecognition() {
    const video = document.getElementById('testVideoElement');
    const canvas = document.getElementById('testCameraCanvas');
    const ctx = canvas.getContext('2d');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    // Load stored descriptors from sheet + local
    await loadStoredDescriptors();

    recognitionInterval = setInterval(async () => {
        if (video.paused || video.ended) return;

        // Detect faces with descriptors
        const detections = await faceapi.detectAllFaces(
            video,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
        ).withFaceLandmarks().withFaceDescriptors();

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (detections.length === 0) {
            // No face - show idle state
            ctx.fillStyle = 'rgba(100, 116, 139, 0.7)';
            ctx.font = 'bold 16px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('👤 No face detected', canvas.width / 2, canvas.height / 2);
            return;
        }

        detections.forEach((det, idx) => {
            const box = det.detection.box;
            const liveDescriptor = Array.from(det.descriptor);

            // Match against stored descriptors
            let bestMatch = null;
            let bestDistance = Infinity;

            if (storedDescriptors.length > 0) {
                for (const stored of storedDescriptors) {
                    const dist = euclideanDistance(liveDescriptor, stored.descriptor);
                    if (dist < bestDistance) {
                        bestDistance = dist;
                        bestMatch = stored;
                    }
                }
            }

            // Determine label and color
            let label, boxColor, textColor;
            const threshold = 0.6;

            if (storedDescriptors.length === 0) {
                label = '📭 Database empty';
                boxColor = '#f59e0b'; // amber
                textColor = '#fbbf24';
            } else if (bestMatch && bestDistance < threshold) {
                const confidence = ((1 - bestDistance) * 100).toFixed(0);
                label = '\u2705 ' + bestMatch.name + ' (' + confidence + '%)';
                boxColor = '#22c55e'; // green
                textColor = '#86efac';
            } else {
                label = '\u274C Not in database';
                boxColor = '#ef4444'; // red
                textColor = '#fca5a5';
            }

            // Draw box
            ctx.strokeStyle = boxColor;
            ctx.lineWidth = 3;
            ctx.strokeRect(box.x, box.y, box.width, box.height);

            // Draw label background
            const padding = 6;
            ctx.font = 'bold 15px sans-serif';
            const textWidth = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
            ctx.fillRect(box.x, box.y - 28, textWidth + padding * 2, 26);

            // Draw label text
            ctx.fillStyle = textColor;
            ctx.textAlign = 'left';
            ctx.fillText(label, box.x + padding, box.y - 8);
        });
    }, 500); // Every 500ms
}

async function loadStoredDescriptors() {
    storedDescriptors = [];

    // Fetch full descriptors from sheet
    try {
        const response = await fetch(API_URL + '?action=descriptors', { method: 'GET' });
        const data = await response.json();
        if (data.status === 'ok' && data.students) {
            storedDescriptors = data.students;
            existingNames = data.students.map(s => s.name);
            log('Loaded ' + storedDescriptors.length + ' descriptors from sheet', 'info');
        }
    } catch (e) {
        log('Sheet offline. Using local data only.', 'warning');
    }

    // Also add any locally saved data not yet synced
    for (const local of localData) {
        const exists = storedDescriptors.some(s => s.name === local.name);
        if (!exists) {
            storedDescriptors.push({ name: local.name, descriptor: local.descriptor });
        }
    }

    log('Total descriptors for recognition: ' + storedDescriptors.length, 'info');
}

function euclideanDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += (a[i] - b[i]) * (a[i] - b[i]);
    }
    return Math.sqrt(sum);
}

// ==================== FACE DETECTION HELPERS ====================
function loadImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

async function detectFace(imageElement) {
    const detections = await faceapi.detectAllFaces(
        imageElement,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 })
    ).withFaceLandmarks().withFaceDescriptors();

    if (detections.length === 0) return null;
    if (detections.length > 1) return { multiple: true };

    const detection = detections[0];
    const descriptor = Array.from(detection.descriptor);

    const canvas = document.createElement('canvas');
    const box = detection.detection.box;
    const padding = Math.min(box.width, box.height) * 0.3;
    const sx = Math.max(0, box.x - padding);
    const sy = Math.max(0, box.y - padding);
    const sw = box.width + padding * 2;
    const sh = box.height + padding * 2;

    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageElement, sx, sy, sw, sh, 0, 0, 200, 200);

    return { descriptor, canvas };
}

// ==================== NAME DIALOG ====================
function showNameDialog(source) {
    const dialog = document.getElementById('nameDialog');
    const select = document.getElementById('nameSelect');
    const preview = document.getElementById('dialogPreview');

    preview.src = currentFaceImage.toDataURL('image/jpeg');

    select.innerHTML = '';
    if (existingNames.length === 0) {
        select.innerHTML = '<option value="">No data stored in sheet</option>';
    } else {
        select.innerHTML = '<option value="">-- Select existing name --</option>';
        existingNames.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        });
    }

    document.getElementById('nameInput').value = '';
    document.getElementById('overwriteWarning').classList.remove('active');
    document.getElementById('saveBtn').textContent = '\u{1F4BE} Save';

    dialog.classList.add('active');
}

function handleNameSelect() {
    const select = document.getElementById('nameSelect');
    const input = document.getElementById('nameInput');
    if (select.value) { input.value = select.value; checkExistingName(); }
}

function checkExistingName() {
    const name = document.getElementById('nameInput').value.trim();
    const warning = document.getElementById('overwriteWarning');
    const saveBtn = document.getElementById('saveBtn');
    const overwriteName = document.getElementById('overwriteName');

    if (existingNames.includes(name)) {
        warning.classList.add('active');
        overwriteName.textContent = name;
        saveBtn.textContent = 'Overwrite';
    } else {
        warning.classList.remove('active');
        saveBtn.textContent = '\u{1F4BE} Save';
    }
}

async function saveFaceData() {
    const name = document.getElementById('nameInput').value.trim();
    if (!name) { showToast('Please enter a name', 'error'); return; }

    const saveBtn = document.getElementById('saveBtn');
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner"></span> Saving...';

    try {
        let success = false;
        let action = 'new';

        const response = await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify({
                action: 'save',
                name: name,
                descriptor: currentFaceDescriptor
            })
        });

        const result = await response.json();

        if (result.status === 'ok') {
            success = true;
            action = result.action || 'new';
            if (!existingNames.includes(name)) existingNames.push(name);
        } else {
            throw new Error(result.message);
        }

        if (success) {
            log((action === 'overwrite' ? 'Overwritten' : 'Saved') + ': ' + name, 'success');
            batchResults.saved++;
            showToast((action === 'overwrite' ? 'Overwritten' : 'Saved') + ': ' + name, 'success');
        }

    } catch (err) {
        const existingIndex = localData.findIndex(d => d.name === name);
        if (existingIndex >= 0) {
            localData[existingIndex] = { name, descriptor: currentFaceDescriptor };
            log('Saved locally (overwrite): ' + name, 'warning');
        } else {
            localData.push({ name, descriptor: currentFaceDescriptor });
            if (!existingNames.includes(name)) existingNames.push(name);
            log('Saved locally: ' + name, 'warning');
        }
        batchResults.saved++;
        showToast('Saved locally (sheet offline)', 'info');
    }

    saveBtn.disabled = false;
    saveBtn.textContent = '\u{1F4BE} Save';
    closeDialog();
    if (isProcessingBatch) nextBatchItem();
}

function skipFace() {
    log('Skipped: ' + currentFileName, 'neutral');
    batchResults.skipped++;
    closeDialog();
    if (isProcessingBatch) nextBatchItem();
}

function cancelDialog() {
    closeDialog();
    if (isProcessingBatch) { isProcessingBatch = false; finishBatch(); }
}

function closeDialog() {
    document.getElementById('nameDialog').classList.remove('active');
    currentFaceDescriptor = null;
    currentFaceImage = null;
}

// ==================== EXPORT ====================
function exportLocalData() {
    if (localData.length === 0 && existingNames.length === 0) {
        showToast('No data to export', 'info');
        return;
    }

    const rows = localData.map(d => d.name + ',' + JSON.stringify(d.descriptor));
    const csv = 'Name,FaceDescriptor\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'face_descriptors_backup.csv';
    a.click();

    log('Exported ' + localData.length + ' records', 'info');
    showToast('Exported ' + localData.length + ' records', 'success');
}

// ==================== LOGGING ====================
function log(message, type) {
    const container = document.getElementById('activityLog');
    const entry = document.createElement('div');
    entry.className = 'log-entry log-' + type;
    const now = new Date();
    const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
    entry.textContent = '[' + time + '] ' + message;
    container.insertBefore(entry, container.firstChild);
}

function showToast(message, type) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast toast-' + type;
    requestAnimationFrame(() => { toast.classList.add('show'); });
    setTimeout(() => { toast.classList.remove('show'); }, 3000);
}
