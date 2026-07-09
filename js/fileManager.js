export const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
let selectedFiles = [];

export function addFiles(newFiles) {
    const currentTotalSize = getTotalSize();
    let sizeToAdd = 0;
    const validFiles = [];

    for (let file of newFiles) {
        const isDuplicate = selectedFiles.some(f => f.name === file.name && f.size === file.size);
        if (isDuplicate) continue;
        if (currentTotalSize + sizeToAdd + file.size > MAX_SIZE_BYTES) {
            alert('Cannot add files. 100MB limit exceeded.');
            break;
        }
        sizeToAdd += file.size;
        validFiles.push(file);
    }
    selectedFiles = [...selectedFiles, ...validFiles];
    return selectedFiles;
}

export function removeFile(index) {
    selectedFiles.splice(index, 1);
    return selectedFiles;
}

export function getFiles() { return selectedFiles; }
export function getTotalSize() { return selectedFiles.reduce((acc, file) => acc + file.size, 0); }

// NEW: Clear file array on reset
export function clearAllFiles() {
    selectedFiles = [];
}

export function formatBytes(bytes) {
    if (bytes === 0) return '0 MB';
    const mb = bytes / (1024 * 1024);
    return mb.toFixed(2) + ' MB';
}

export async function getTransferableData() {
    if (selectedFiles.length === 0) return null;
    if (selectedFiles.length === 1) return selectedFiles[0]; 

    const zip = new JSZip();
    selectedFiles.forEach(file => zip.file(file.name, file));
    const content = await zip.generateAsync({ type: "blob" });
    return new File([content], "Sharely_Transfer.zip", { type: "application/zip" });
}
