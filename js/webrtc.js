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
            setTimeout(() => attemptConnection(), 1500); // 1.5s delay before retry
        } else {
            onConnectionFailed(err);
        }
    }

    attemptConnection();
}

// ----- HIGH-SPEED BUFFERED TRANSFER LOGIC -----
const CHUNK_SIZE = 64 * 1024; // 64KB
const MAX_BUFFER_SIZE = 2 * 1024 * 1024; // Pause sending if buffer hits 2MB

export async function startSendingFile(file, onProgressCallback, onCompleteCallback) {
    if (!connection || !connection.dataChannel) return;
    
    let offset = 0;
    
    // Set the low watermark to 1MB. When buffer drains below this, resume sending.
    connection.dataChannel.bufferedAmountLowThreshold = MAX_BUFFER_SIZE / 2;

    connection.send({ type: 'META', name: file.name, size: file.size });

    const dataListener = (data) => {
        if (data.type === 'META_ACK') {
            // We no longer need to listen for ACKs, deregister the listener
            connection.off('data', dataListener);
            
            // Register the native buffer drain event and start pumping data
            connection.dataChannel.onbufferedamountlow = pumpData;
            pumpData();
        }
    };
    connection.on('data', dataListener);

    async function pumpData() {
        if (!connection || !connection.dataChannel) return;

        while (offset < file.size) {
            // If the underlying WebRTC buffer is too full, exit the loop.
            // The browser will automatically call `onbufferedamountlow` when it drains.
            if (connection.dataChannel.bufferedAmount > MAX_BUFFER_SIZE) {
                return;
            }

            const chunk = file.slice(offset, offset + CHUNK_SIZE);
            const buffer = await chunk.arrayBuffer(); // Modern async read
            
            if (!connection || !connection.dataChannel) return; // Abort if cancelled during await

            connection.send({ type: 'CHUNK', payload: buffer });
            offset += buffer.byteLength;
            
            onProgressCallback(offset, file.size);
        }

        // When all chunks are queued, send completion flag and clean up
        if (offset >= file.size) {
            connection.send({ type: 'DONE' });
            connection.dataChannel.onbufferedamountlow = null; 
            onCompleteCallback();
        }
    }
}

export function cancelTransfer() {
    if (connection) {
        connection.send({ type: 'CANCEL' });
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
