require('dotenv').config(); // Load environment variables

// Status bot (default: aktif)
let botStatus = true;

// Nomor admin
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// Fungsi untuk menangani pesan admin
const handleAdminMessage = async (sock, message) => {
    const sender = message.key.remoteJid;
    const messageContent = message.message?.conversation || message.message?.extendedTextMessage?.text;

    if (!messageContent) return;

    // Konversi pesan ke huruf kecil agar lebih mudah dideteksi
    const lowerMessage = messageContent.toLowerCase();

    // Cek apakah pengirim adalah admin
    if (sender === ADMIN_NUMBER + '@s.whatsapp.net') {
        if (lowerMessage === '.on') {
            botStatus = true;
            await sock.sendMessage(sender, { 
                text: "✅ Bot telah diaktifkan." });
        } else if (lowerMessage === '.off') {
            botStatus = false;
            await sock.sendMessage(sender, {
                 text: "❌ Bot telah dinonaktifkan." });
        }
    }
};

// Fungsi untuk memeriksa status bot
const isBotActive = () => {
    return botStatus;
};

module.exports = {
    handleAdminMessage,
    isBotActive
};