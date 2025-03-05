const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('baileys');
const { handleMessage } = require('./handlers/messageHandler'); // Impor handleMessage
const { handleAdminMessage } = require('./handlers/adminHandler'); // Impor handleAdminMessage dan 
require('dotenv').config();

let botState = {
    status: true, // true = aktif, false = nonaktif
    admin: process.env.ADMIN_NUMBER, // Nomor admin dari environment variable
    lock: false, // Untuk mencegah perintah lain diproses bersamaan
    lastAction: new Date() // Waktu terakhir bot diupdate
  };

async function connectToWhatsApp() {
    try {
        console.log('🚀 Memulai bot WhatsApp...');

        // Inisialisasi session
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        // Buat koneksi ke WhatsApp
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
        });

        // Event handler untuk koneksi
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('🔄 Mencoba reconnect...');
                if (shouldReconnect) connectToWhatsApp();
            }
            
            if (connection === 'open') {
                console.log('✅ Connected!');
            }
        });

        // Handler pesan masuk
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const message of messages) {
                if (!message.key.fromMe) {
                    console.log("Pesan diterima:", message.message?.conversation || message.message?.extendedTextMessage?.text);
                    await handleMessage(sock, message);

                    // Handle pesan admin terlebih dahulu
      if (await handleAdminMessage(sock, message)) {
        continue; // Lanjut ke pesan berikutnya jika pesan admin sudah ditangani
      }
                               await handleAdminMessage(sock, message);
                            }
                        }
                    });


        // Simpan credentials
        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error('❌ Error:', error);
    }
}

connectToWhatsApp();
