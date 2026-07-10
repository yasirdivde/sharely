let peer = null;
let currentCode = null;
let connection = null;

const peerConfig = {
    config: { 
        'iceServers': [
            { urls: 'stun:stun.l.google.com:19302' }, 
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ] 
    }
};

export function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
}

export function initSender(onConnectionEstablished, onReceiverData, onDisconnect) {
    currentCode = generateCode();
    peer = new Peer(currentCode, peerConfig);
    peer.on('connection', (conn) => {
        connection = conn;
        conn.on('open', () => onConnectionEstablished(conn));
        conn.on('data', onReceiverData);
        conn.on('close', onDisconnect);
    });
    return currentCode;
}

export function initReceiver(codeToConnect, onConnectionEstablished, onConnectionFailed, onSenderData, onDisconnect) {
    let retries = 0;
    const MAX_RETRIES = 3;

    function attemptConnection() {
        peer = new Peer(peerConfig);

        peer.on('open', (id) => {
            // Explicitly request a reliable channel for ordered chunk delivery
            connection = peer.connect(codeToConnect.toUpperCase(), { reliable: true });

            connection.on('open', () => {
                onConnectionEstablished(connection);
            });

            connection.on('data', (data) => onSenderData(data, connection));
            connection.on('close', onDisconnect);

            connection.on('error', (err) => {
                handleFailure(err);
            });
        });

        peer.on('error', (err) => {
            handleFailure(err);
        });
    }

    function handleFailure(err) {
        console.warn(`Connection attempt failed: ${err.type || err}`);
        if (connection) connection.close();
        if (peer) peer.destroy();
        
        retries++;
        if (retries <= MAX_RETRIES) {
            console.log(`Retrying connection... Attempt ${retries} of ${MAX_RETRIES}`);
            setTimeout(() => attemptConnection(), 1500); 
        } else {
            onConnectionFailed(err);
        }
    }

    attemptConnection();
}

// ----- HIGH-SPEED STREAMING TRANSFER LOGIC -----
const CHUNK_SIZE = 64 * 1024; // 64KB safe maximum for WebRTC messages
const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // Increased to 4MB

export async function startSendingFile(file, onProgressCallback, onCompleteCallback) {
    if (!connection || !connection.dataChannel) return;
    
    // Alert us when the buffer drops below half capacity (2MB)
    connection.dataChannel.bufferedAmountLowThreshold = MAX_BUFFER_SIZE / 2;

    connection.send({ type: 'META', name: file.name, size: file.size });

    const dataListener = async (data) => {
        if (data.type === 'META_ACK') {
            connection.off('data', dataListener);
            await streamData();
        }
    };
    connection.on('data', dataListener);

    async function streamData() {
        let reader = null;
        try {
            reader = file.stream().getReader();
            let totalSent = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Handle cancellation while the read was awaiting
                if (!connection || !connection.dataChannel || connection.dataChannel.readyState !== 'open') {
                    await reader.cancel();
                    return;
                }

                let chunkOffset = 0;
                while (chunkOffset < value.byteLength) {
                    
                    // 1. Flow Control: Pause if WebRTC buffer is full
                    if (connection.dataChannel.bufferedAmount >= MAX_BUFFER_SIZE) {
                        try {
                            await new Promise((resolve, reject) => {
                                // 15-second failsafe timeout
                                const timeoutId = setTimeout(() => {
                                    if (connection && connection.dataChannel) {
                                        connection.dataChannel.onbufferedamountlow = null;
                                    }
                                    reject(new Error("WebRTC buffer drain timeout"));
                                }, 15000);

                                connection.dataChannel.onbufferedamountlow = () => {
                                    clearTimeout(timeoutId);
                                    connection.dataChannel.onbufferedamountlow = null;
                                    resolve();
                                };
                            });
                        } catch (timeoutErr) {
                            console.error(timeoutErr);
                            await reader.cancel();
                            cancelTransfer(); // Abort gracefully
                            return;
                        }
                    }

                    // Failsafe in case user cancelled during the promise await
                    if (!connection || !connection.dataChannel || connection.dataChannel.readyState !== 'open') {
                        await reader.cancel();
                        return;
                    } 

                    // 2. Extract up to 64KB
                    const end = Math.min(chunkOffset + CHUNK_SIZE, value.byteLength);
                    const subChunk = value.subarray(chunkOffset, end);
                    
                    // 3. Send raw binary data immediately
                    connection.send(subChunk);
                    chunkOffset = end;
                    totalSent += subChunk.byteLength;
                    
                    onProgressCallback(totalSent, file.size);
                }
            }

            // Cleanup event handler and complete transfer
            if (connection && connection.dataChannel) {
                connection.dataChannel.onbufferedamountlow = null;
            }
            
            if (totalSent >= file.size) {
                connection.send({ type: 'DONE' });
                onCompleteCallback();
            }

        } catch (err) {
            console.error("Stream reading error:", err);
            if (reader) await reader.cancel();
            cancelTransfer();
        }
    }
}

export function cancelTransfer() {
    if (connection) {
        if (connection.dataChannel && connection.dataChannel.readyState === 'open') {
            connection.send({ type: 'CANCEL' });
        }
        setTimeout(() => terminateConnection(), 100);
    } else {
        terminateConnection();
    }
}

export function terminateConnection() {
    if (connection) {
        connection.close();
    }
    if (peer) { 
        peer.destroy(); 
        peer = null; 
    }
    currentCode = null;
    connection = null;
}
