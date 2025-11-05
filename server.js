const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

let client;
let qrCodeData = null;
let isReady = false;
let isInitializing = false;

// Initialize WhatsApp Client
function initializeClient() {
    // Prevent multiple initializations
    if (isInitializing) {
        console.log('Client is already initializing...');
        return;
    }

    if (client && isReady) {
        console.log('Client is already initialized and ready');
        return;
    }

    isInitializing = true;
    qrCodeData = null;
    isReady = false;

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "whatsapp-gateway"
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        }
    });

    // Event: QR Code Generated
    client.on('qr', (qr) => {
        console.log('QR Code received, scan please!');
        qrcode.generate(qr, { small: true });
        qrCodeData = qr;
        isInitializing = false; // QR generated, initialization process done
    });

    // Event: Client Ready
    client.on('ready', () => {
        console.log('WhatsApp Client is ready!');
        isReady = true;
        qrCodeData = null; // Clear QR after authenticated
        isInitializing = false;
    });

    // Event: Client Authenticated
    client.on('authenticated', () => {
        console.log('WhatsApp authenticated!');
        qrCodeData = null; // Clear QR immediately after auth
    });

    // Event: Authentication Failure
    client.on('auth_failure', (msg) => {
        console.error('Authentication failure:', msg);
        isReady = false;
        qrCodeData = null;
        isInitializing = false;
    });

    // Event: Client Disconnected
    client.on('disconnected', (reason) => {
        console.log('WhatsApp disconnected:', reason);
        isReady = false;
        qrCodeData = null;
        isInitializing = false;
    });

    // Event: Receive Message (untuk webhook ke Laravel)
    client.on('message', async (message) => {
        console.log('Message received:', message.body);
        
        // Optional: Forward ke Laravel webhook
        try {
            const axios = require('axios');
            await axios.post('http://localhost:8000/whatsapp/webhook', {
                from: message.from,
                body: message.body,
                timestamp: message.timestamp
            });
        } catch (error) {
            console.error('Webhook error:', error.message);
        }
    });

    client.initialize();
}

// API Routes

// Start WhatsApp Client (Manual start if not auto-started)
app.post('/api/start', (req, res) => {
    if (isReady) {
        return res.json({ 
            status: 'info', 
            message: 'WhatsApp client already connected' 
        });
    }

    if (isInitializing) {
        return res.json({ 
            status: 'info', 
            message: 'WhatsApp client is initializing...' 
        });
    }

    if (!client) {
        initializeClient();
        res.json({ 
            status: 'success', 
            message: 'WhatsApp client started. Please check /api/qr for QR code' 
        });
    } else {
        res.json({ 
            status: 'info', 
            message: 'WhatsApp client already exists' 
        });
    }
});

// Restart WhatsApp Client (after logout)
app.post('/api/restart', async (req, res) => {
    try {
        // Destroy existing client first
        if (client) {
            try {
                await client.destroy();
            } catch (error) {
                console.log('Error destroying client:', error.message);
            }
            client = null;
        }

        isReady = false;
        qrCodeData = null;
        isInitializing = false;

        // Wait a bit before reinitializing
        setTimeout(() => {
            initializeClient();
        }, 1000);

        res.json({ 
            status: 'success', 
            message: 'WhatsApp client restarting. Check /api/qr in a few seconds' 
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    }
});

// Get QR Code
app.get('/api/qr', (req, res) => {
    if (isReady) {
        return res.json({ 
            status: 'ready', 
            message: 'WhatsApp already connected',
            qr: null
        });
    }

    if (isInitializing && !qrCodeData) {
        return res.json({ 
            status: 'initializing', 
            message: 'Client is initializing, please wait...',
            qr: null
        });
    }

    if (qrCodeData) {
        return res.json({ 
            status: 'success', 
            qr: qrCodeData,
            message: 'Scan QR code with WhatsApp'
        });
    }

    res.json({ 
        status: 'waiting', 
        message: 'Waiting for QR code. Try /api/start or /api/restart',
        qr: null
    });
});

// Check Status
app.get('/api/status', (req, res) => {
    res.json({
        status: isReady ? 'ready' : (isInitializing ? 'initializing' : 'not_ready'),
        isReady: isReady,
        isInitializing: isInitializing,
        hasQR: qrCodeData !== null,
        hasClient: client !== null,
        message: isReady 
            ? 'WhatsApp is connected' 
            : isInitializing 
                ? 'WhatsApp is initializing...'
                : 'WhatsApp is not connected'
    });
});

// Send Text Message
app.post('/api/send-message', async (req, res) => {
    try {
        if (!isReady) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'WhatsApp is not ready' 
            });
        }

        const { phone, message } = req.body;

        if (!phone || !message) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'Phone and message are required' 
            });
        }

        // Format phone number
        let formattedPhone = phone.replace(/[^0-9]/g, '');
        
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '62' + formattedPhone.substring(1);
        }
        
        if (!formattedPhone.startsWith('62')) {
            formattedPhone = '62' + formattedPhone;
        }

        const chatId = formattedPhone + '@c.us';
        
        // Check if number is registered on WhatsApp
        const isRegistered = await client.isRegisteredUser(chatId);
        
        if (!isRegistered) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'Phone number is not registered on WhatsApp' 
            });
        }

        // Send message
        const result = await client.sendMessage(chatId, message);

        res.json({ 
            status: 'success', 
            message: 'Message sent successfully',
            data: {
                phone: formattedPhone,
                messageId: result.id._serialized
            }
        });

    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    }
});

// Send Media (Image, Document, etc)
app.post('/api/send-media', async (req, res) => {
    try {
        if (!isReady) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'WhatsApp is not ready' 
            });
        }

        const { phone, mediaUrl, caption, filename } = req.body;

        if (!phone || !mediaUrl) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'Phone and mediaUrl are required' 
            });
        }

        // Format phone number
        let formattedPhone = phone.replace(/[^0-9]/g, '');
        
        if (formattedPhone.startsWith('0')) {
            formattedPhone = '62' + formattedPhone.substring(1);
        }
        
        if (!formattedPhone.startsWith('62')) {
            formattedPhone = '62' + formattedPhone;
        }

        const chatId = formattedPhone + '@c.us';

        // Download and send media
        const MessageMedia = require('whatsapp-web.js').MessageMedia;
        const media = await MessageMedia.fromUrl(mediaUrl, { 
            filename: filename || 'file' 
        });

        const result = await client.sendMessage(chatId, media, { 
            caption: caption || '' 
        });

        res.json({ 
            status: 'success', 
            message: 'Media sent successfully',
            data: {
                phone: formattedPhone,
                messageId: result.id._serialized
            }
        });

    } catch (error) {
        console.error('Send media error:', error);
        res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    }
});

// Logout
app.post('/api/logout', async (req, res) => {
    try {
        if (client) {
            await client.logout();
            await client.destroy();
            client = null;
            isReady = false;
            qrCodeData = null;
            isInitializing = false;
            
            res.json({ 
                status: 'success', 
                message: 'Logged out successfully. Use /api/restart to reconnect' 
            });
        } else {
            res.json({ 
                status: 'info', 
                message: 'No active session' 
            });
        }
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    }
});

// Start server
const PORT = process.env.PORT || 3006;
app.listen(PORT, () => {
    console.log(`WhatsApp API Server running on port ${PORT}`);
    console.log(`API Base URL: http://localhost:${PORT}/api`);
    console.log('\nAvailable endpoints:');
    console.log('  POST /api/start     - Start WhatsApp client');
    console.log('  POST /api/restart   - Restart WhatsApp client');
    console.log('  GET  /api/qr        - Get QR code');
    console.log('  GET  /api/status    - Check connection status');
    console.log('  POST /api/send-message - Send text message');
    console.log('  POST /api/send-media   - Send media');
    console.log('  POST /api/logout    - Logout from WhatsApp');
});

// Initialize client on startup (optional - comment this if you want manual start)
initializeClient();