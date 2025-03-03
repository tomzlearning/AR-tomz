require('dotenv').config(); // Load environment variables
const axios = require('axios');
const { updateInvoiceStatus, getInvoiceById } = require('./invoiceHandler');

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
        // Command untuk mengaktifkan/nonaktifkan bot
        if (lowerMessage === '.on') {
            botStatus = true;
            await sock.sendMessage(sender, { 
                text: "✅ Bot telah diaktifkan." 
            });
        } else if (lowerMessage === '.off') {
            botStatus = false;
            await sock.sendMessage(sender, {
                text: "❌ Bot telah dinonaktifkan." 
            });
        }

        // Command untuk update status invoice
        if (lowerMessage.startsWith('.konfirmasi ')) {
            const invoiceId = messageContent.split(' ')[1];
            await updateInvoiceStatus(invoiceId, 'LUNAS', 'Status_Pembayaran'); // ◀ Update Status_Pembayaran
            await sock.sendMessage(sender, { 
                text: `✅ Pembayaran untuk ${invoiceId} dikonfirmasi.` 
            });

        } else if (lowerMessage.startsWith('.proses ')) {
            const invoiceId = messageContent.split(' ')[1];
            await updateInvoiceStatus(invoiceId, 'DIPROSES', 'Status_Pengiriman'); // ◀ Update Status_Pengiriman
            await sock.sendMessage(sender, { 
                text: `✅ Pesanan ${invoiceId} sedang diproses.` 
            });

        } else if (lowerMessage.startsWith('.kirim ')) {
            const [invoiceId, resi] = messageContent.split(' ').slice(1);
            await updateInvoiceStatus(invoiceId, 'DIKIRIM', 'Status_Pengiriman'); // ◀ Update Status_Pengiriman
            await axios.post(process.env.APP_SCRIPT_URL, { // Update nomor resi
                action: "update",
                sheet: "DATA_PESANAN",
                id: invoiceId,
                data: { No_Resi: resi },
            });
            await sock.sendMessage(sender, { 
                text: `✅ Pesanan ${invoiceId} telah dikirim. Resi: ${resi}` 
            });

        } else if (lowerMessage.startsWith('.retur ')) {
            const invoiceId = messageContent.split(' ')[1];
            const invoice = await getInvoiceById(invoiceId);
            
            // Handle retur berdasarkan jenis pembayaran
            if (invoice.paymentStatus === "PENDING") { // COD
                await updateInvoiceStatus(invoiceId, 'GAGAL', 'Status_Pembayaran');
            } else { // Non-COD
                await updateInvoiceStatus(invoiceId, 'REFUND', 'Status_Pembayaran');
            }
            await updateInvoiceStatus(invoiceId, 'DITOLAK', 'Status_Pengiriman');
            await sock.sendMessage(sender, { 
                text: `✅ Retur untuk ${invoiceId} diproses.` 
            });

        } else if (lowerMessage.startsWith('.verifikasi ')) {
            const invoiceId = messageContent.split(' ')[1];
            await updateInvoiceStatus(invoiceId, 'LUNAS', 'Status_Pembayaran');
            await sock.sendMessage(sender, { 
                text: `✅ Pembayaran untuk ${invoiceId} telah diverifikasi.` 
            });
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
