let peer = null;
let currentCode = null;
let connection = null;

// Configured with multiple robust STUN servers for maximum connection reliability
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
    peer = new Peer(peerConfig);
    peer.on('open', (id) => {
        connection = peer.connect(codeToConnect.toUpperCase());
        connection.on('open', () => onConnectionEstablished(connection));
        connection.on('data', (data) => onSenderData(data, connection));
        connection.on('close', onDisconnect);
        connection.on('error', onConnectionFailed);
    });
    peer.on('error', onConnectionFailed);
}

// Reduced Chunk Size to 64KB. This prevents the WebRTC 'RTCDataChannel send queue is full' error on stricter networks
const CHUNK_SIZE = 64 * 1024; 

export function startSendingFile(file, onProgressCallback, onCompleteCallback) {
    if (!connection) return;
    
    let offset = 0;
    connection.send({ type: 'META', name: file.name, size: file.size });

    const dataListener = (data) => {
        if (data.type === 'META_ACK' || data.type === 'CHUNK_ACK') {
            if (offset < file.size) {
                readNextChunk();
            } else {
                connection.send({ type: 'DONE' });
                connection.off('data', dataListener);
                onCompleteCallback();
            }
        }
    };
    connection.on('data', dataListener);

    function readNextChunk() {
        if(!connection) return; 
        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const reader = new FileReader();
        reader.onload = (e) => {
            if(connection) {
                connection.send({ type: 'CHUNK', payload: e.target.result });
                offset += e.target.result.byteLength;
                onProgressCallback(offset, file.size);
            }
        };
        reader.readAsArrayBuffer(slice);
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
    if (connection) connection.close();
    if (peer) { peer.destroy(); peer = null; }
    currentCode = null;
    connection = null;
}
