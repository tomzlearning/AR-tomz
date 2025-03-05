require('dotenv').config();
const axios = require('axios');
const { updateInvoiceStatus, getInvoiceById } = require('./invoiceHandler');

let botState = {
  status: true, // true = aktif, false = nonaktif
  admin: process.env.ADMIN_NUMBER, // Nomor admin dari environment variable
  lock: false, // Untuk mencegah perintah lain diproses bersamaan
  lastAction: new Date() // Waktu terakhir bot diupdate
};

function isBotActive() {
  return botState.status;
}

async function handleAdminMessage(sock, message) {
  const sender = message.key.remoteJid;
  const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text;

  // Pastikan hanya admin yang bisa mengontrol bot
  if (sender !== botState.admin + '@s.whatsapp.net') return false;

  // Handle perintah .on dan .off
  if (messageText === '.on' || messageText === '.off') {
    const targetStatus = messageText === '.on';

    // Validasi status saat ini
    if (botState.status === targetStatus) {
      const statusMsg = targetStatus ? 'aktif' : 'nonaktif';
      await sock.sendMessage(sender, {
        text: `ℹ️ Bot sudah dalam status ${statusMsg}`
      });
      return true;
    }

    // Update status bot
    botState.status = targetStatus;

    // Kirim konfirmasi ke admin
    await sock.sendMessage(sender, {
      text: targetStatus ? '✅ Bot berhasil diaktifkan' : '❌ Bot berhasil dinonaktifkan'
    });

    // Log perubahan status
    console.log(`[STATUS] Status baru: ${botState.status}`);
    return true;
  }

  // Handle perintah admin lainnya
  const command = messageText.toLowerCase();
  if (command.startsWith('.konfirmasi')) {
    return await handleConfirmationCommand(sock, command, sender);
  } else if (command.startsWith('.proses')) {
    return await handleProcessCommand(sock, command, sender);
  } else if (command.startsWith('.kirim')) {
    return await handleShippingCommand(sock, command, sender);
  } else if (command.startsWith('.retur')) {
    return await handleReturnCommand(sock, command, sender);
  } else if (command.startsWith('.verifikasi')) {
    return await handleVerificationCommand(sock, command, sender);
  }

  return false;
}

async function handleConfirmationCommand(sock, command, sender) {
  const invoiceId = command.split(' ')[1];
  
  if (!invoiceId) {
    await sock.sendMessage(sender, {
      text: "⚠️ Format: .konfirmasi <invoice_id>"
    });
    throw new Error('Format: .konfirmasi <invoice_id>');
  }
  
  // Update status invoice
  await updateInvoiceStatus(invoiceId, 'LUNAS', 'Status_Pembayaran');
  
  // Kirim notifikasi ke user
  const invoice = await getInvoiceById(invoiceId);
  if (invoice?.phone) {
    await sock.sendMessage(
      `${invoice.phone}@s.whatsapp.net`,
      { text: `✅ Pembayaran invoice ${invoiceId} telah dikonfirmasi` }
    );
  }

  await sock.sendMessage(sender, {
    text: `✅ Invoice ${invoiceId} berhasil dikonfirmasi`
  });
  
  return true;
}

async function handleProcessCommand(sock, command, sender) {
  const invoiceId = command.split(' ')[1];
  
  if (!invoiceId) {
    await sock.sendMessage(sender, {
      text: "⚠️ Format: .proses <invoice_id>"
    });
    throw new Error('Format: .proses <invoice_id>');
  }
  
  await updateInvoiceStatus(invoiceId, 'DIPROSES', 'Status_Pengiriman');
  
  await sock.sendMessage(sender, {
    text: `✅ Invoice ${invoiceId} sedang diproses`
  });
  
  return true;
}

async function handleShippingCommand(sock, command, sender) {
  const args = command.split(' ');
  const invoiceId = args[1];
  const resi = args[2];
  
  if (!invoiceId || !resi) {
    await sock.sendMessage(sender, {
      text: "⚠️ Format: .kirim <invoice_id> <resi>"
    });
    throw new Error('Format: .kirim <invoice_id> <resi>');
  }
  
  // Update database
  await axios.post(process.env.APP_SCRIPT_URL, {
    action: "update",
    sheet: "DATA_PESANAN",
    id: invoiceId,
    data: { No_Resi: resi },
  });
  
  await updateInvoiceStatus(invoiceId, 'DIKIRIM', 'Status_Pengiriman');
  
  await sock.sendMessage(sender, {
    text: `✅ Invoice ${invoiceId} telah dikirim\n📦 Resi: ${resi}`
  });
  
  return true;
}

async function handleReturnCommand(sock, command, sender) {
  const invoiceId = command.split(' ')[1];
  
  if (!invoiceId) {
    await sock.sendMessage(sender, {
      text: "⚠️ Format: .retur <invoice_id>"
    });
    throw new Error('Format: .retur <invoice_id>');
  }
  
  // Handle retur berdasarkan tipe pembayaran
  const invoice = await getInvoiceById(invoiceId);
  const paymentStatus = invoice.paymentStatus === 'PENDING' ? 'GAGAL' : 'REFUND';
  
  await updateInvoiceStatus(invoiceId, paymentStatus, 'Status_Pembayaran');
  await updateInvoiceStatus(invoiceId, 'DITOLAK', 'Status_Pengiriman');
  
  await sock.sendMessage(sender, {
    text: `✅ Retur untuk ${invoiceId} diproses\nStatus: ${paymentStatus}`
  });
  
  return true;
}

async function handleVerificationCommand(sock, command, sender) {
  const invoiceId = command.split(' ')[1];
  
  if (!invoiceId) {
    await sock.sendMessage(sender, {
      text: "⚠️ Format: .verifikasi <invoice_id>"
    });
    throw new Error('Format: .verifikasi <invoice_id>');
  }
  
  await updateInvoiceStatus(invoiceId, 'LUNAS', 'Status_Pembayaran');
  
  await sock.sendMessage(sender, {
    text: `✅ Pembayaran ${invoiceId} telah diverifikasi`
  });
  
  return true;
}

module.exports = {
  handleAdminMessage,
  isBotActive,
  handleConfirmationCommand,
  handleProcessCommand,
  handleShippingCommand,
  handleReturnCommand,
  handleVerificationCommand
};
