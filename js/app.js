import { addFiles, removeFile, getTransferableData } from './fileManager.js';
import { showScreen, renderFileList, renderWaitingScreen, startTimer, stopTimer, setupOTPInputs, setupTransferScreen, updateTransferProgress, renderCompleteScreen, toggleQRScanner, showToast } from './ui.js';
import { initSender, initReceiver, terminateConnection, cancelTransfer, startSendingFile } from './webrtc.js';

document.addEventListener('DOMContentLoaded', () => {
    
    // Buttons
    const btnHomeSend = document.getElementById('btn-home-send');
    const btnHomeReceive = document.getElementById('btn-home-receive');
    const btnConnectPc = document.getElementById('btn-connect-pc');
    
    const btnBackHomeFromSend = document.getElementById('btn-back-home-from-send');
    const btnBackHomeFromReceive = document.getElementById('btn-back-home-from-receive');
    const btnBackHomeFromHelp = document.getElementById('btn-back-home-from-help');
    
    const btnCancelShare = document.getElementById('btn-cancel-share');
    const btnAbortTransfer = document.getElementById('btn-abort-transfer');
    const btnBackToHome = document.getElementById('btn-back-to-home');
    
    const btnAddFiles = document.getElementById('btn-add-files');
    const fileInput = document.getElementById('file-input');
    const btnStartSharing = document.getElementById('btn-start-sharing');
    
    const btnConnectReceiver = document.getElementById('btn-connect-receiver');
    const btnScanQR = document.getElementById('btn-scan-qr');
    const btnCloseScanner = document.getElementById('btn-close-scanner');
    
    const btnDownloadFile = document.getElementById('btn-download-file');

    // State Variables
    let preparedFile = null; 
    let currentInputCode = null;
    let transferStartTime = 0;
    let html5QrcodeScanner = null;
    let isTransferring = false;
    let receiveBuffer = [];
    let pendingDownloadBlobUrl = null;
    let pendingDownloadFilename = null;

    // ----- CRITICAL MEMORY CLEANUP -----
    function cleanupMemory() {
        if (pendingDownloadBlobUrl) {
            URL.revokeObjectURL(pendingDownloadBlobUrl); // Free RAM
            pendingDownloadBlobUrl = null;
        }
        receiveBuffer = []; // Clear array from memory
        preparedFile = null;
    }

    // ----- NAVIGATION -----
    btnHomeSend.addEventListener('click', () => showScreen('screen-send'));
    btnHomeReceive.addEventListener('click', () => showScreen('screen-receive'));
    btnConnectPc.addEventListener('click', () => showScreen('screen-help'));
    
    const goHome = () => { 
        terminateConnection(); 
        isTransferring = false;
        cleanupMemory();
        showScreen('screen-home'); 
    };
    
    btnBackHomeFromSend.addEventListener('click', goHome);
    btnBackHomeFromReceive.addEventListener('click', goHome);
    btnBackHomeFromHelp.addEventListener('click', goHome);
    btnBackToHome.addEventListener('click', goHome);
    
    btnCancelShare.addEventListener('click', () => { stopTimer(); terminateConnection(); showScreen('screen-send'); });
    
    btnAbortTransfer.addEventListener('click', () => {
        if(confirm("Are you sure you want to cancel the transfer?")) { 
            cancelTransfer(); 
            showToast("You cancelled the transfer.");
            goHome(); 
        }
    });

    // ----- SENDER LOGIC -----
    btnAddFiles.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        updateUI(addFiles(Array.from(e.target.files)));
        fileInput.value = ''; 
    });

    btnStartSharing.addEventListener('click', async () => {
        const originalText = btnStartSharing.innerHTML;
        btnStartSharing.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Preparing...';
        btnStartSharing.setAttribute('disabled', 'true');

        try {
            preparedFile = await getTransferableData(); 
            const code = initSender(
                (connection) => { 
                    stopTimer();
                    isTransferring = true;
                    setupTransferScreen('sender', preparedFile.name, preparedFile.size);
                    showScreen('screen-transfer');
                    transferStartTime = Date.now();
                    
                    startSendingFile(preparedFile, 
                        (loaded, total) => updateTransferProgress(loaded, total, transferStartTime),
                        () => { 
                            isTransferring = false;
                            renderCompleteScreen('sender', preparedFile.name, preparedFile.size, false);
                            showScreen('screen-complete');
                        }
                    );
                },
                (data) => { 
                    if(data.type === 'CANCEL') {
                        showToast("Receiver cancelled the transfer.");
                        goHome();
                    }
                },
                () => {
                    if(isTransferring) {
                        showToast("Connection lost with receiver.");
                        goHome();
                    }
                }
            );
            renderWaitingScreen(code);
            showScreen('screen-waiting');
            startTimer(300, () => { showToast("Session expired."); terminateConnection(); showScreen('screen-send'); });
        } catch (err) {
            console.error(err); showToast("Error preparing files.");
        } finally {
            btnStartSharing.innerHTML = originalText; btnStartSharing.removeAttribute('disabled');
        }
    });

    function updateUI(files) { renderFileList(files, (idx) => updateUI(removeFile(idx))); }

    // ----- RECEIVER LOGIC -----
    setupOTPInputs((code) => { currentInputCode = code; });

    let expectedSize = 0;
    let expectedName = "";

    function executeConnection(codeToConnect) {
        const originalText = btnConnectReceiver.innerHTML;
        btnConnectReceiver.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...';
        btnConnectReceiver.setAttribute('disabled', 'true');

        initReceiver(codeToConnect, 
            (connection) => { 
                btnConnectReceiver.innerHTML = originalText; btnConnectReceiver.removeAttribute('disabled');
            }, 
            (error) => { 
                btnConnectReceiver.innerHTML = originalText; btnConnectReceiver.removeAttribute('disabled');
                showToast('Connection Failed. Check code.');
            },
            (data, activeConn) => { 
                if (data.type === 'META') {
                    isTransferring = true;
                    expectedName = data.name; expectedSize = data.size;
                    receiveBuffer = []; // Reset on new meta
                    transferStartTime = Date.now();
                    setupTransferScreen('receiver', expectedName, expectedSize);
                    showScreen('screen-transfer');
                    activeConn.send({ type: 'META_ACK' });
                } 
                else if (data.type === 'CHUNK') {
                    receiveBuffer.push(data.payload);
                    const loaded = receiveBuffer.reduce((acc, val) => acc + val.byteLength, 0);
                    updateTransferProgress(loaded, expectedSize, transferStartTime);
                    activeConn.send({ type: 'CHUNK_ACK' });
                } 
                else if (data.type === 'DONE') {
                    isTransferring = false;
                    
                    const blob = new Blob(receiveBuffer);
                    pendingDownloadBlobUrl = URL.createObjectURL(blob); // Hold URL for download button
                    pendingDownloadFilename = expectedName;
                    
                    renderCompleteScreen('receiver', expectedName, expectedSize, true);
                    showScreen('screen-complete');
                }
                else if (data.type === 'CANCEL') {
                    showToast("Sender cancelled the transfer.");
                    goHome();
                }
            },
            () => {
                if(isTransferring) {
                    showToast("Connection lost with sender.");
                    goHome();
                }
            }
        );
    }

    btnConnectReceiver.addEventListener('click', () => {
        if (!currentInputCode || currentInputCode.length !== 6) return;
        executeConnection(currentInputCode);
    });

    btnDownloadFile.addEventListener('click', () => {
        if(!pendingDownloadBlobUrl) return;
        const a = document.createElement('a');
        a.href = pendingDownloadBlobUrl;
        a.download = pendingDownloadFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });

    // ----- QR SCANNER LOGIC -----
    btnScanQR.addEventListener('click', () => {
        toggleQRScanner(true);
        html5QrcodeScanner = new Html5Qrcode("qr-reader");
        const config = { fps: 10, qrbox: { width: 250, height: 250 } };
        
        html5QrcodeScanner.start({ facingMode: "environment" }, config, (decodedText) => {
            html5QrcodeScanner.stop().then(() => {
                toggleQRScanner(false);
                if(decodedText && decodedText.length === 6) executeConnection(decodedText); 
                else showToast("Invalid QR Code Format.");
            });
        }, () => {}).catch(() => {
            showToast("Camera permission denied.");
            toggleQRScanner(false);
        });
    });

    btnCloseScanner.addEventListener('click', () => {
        if(html5QrcodeScanner) {
            html5QrcodeScanner.stop().then(() => toggleQRScanner(false)).catch(() => toggleQRScanner(false));
        } else {
            toggleQRScanner(false);
        }
    });
});
