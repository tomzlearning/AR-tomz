const { sendProductList, sendProductDetail, getProducts } = require('./productHandler');
const { handleAdminMessage, isBotActive } = require('./adminHandler');
const { saveInvoiceToSheet, waitForUserResponse, checkShippingCost, parseProductsInput, showInvoiceConfirmation, getInvoicesByPhone, getInvoiceById, updateInvoiceStatus, generateInvoicePDF, generateInvoiceId } = require('./invoiceHandler');
const fs = require('fs');
const axios = require('axios');
const { downloadMediaMessage } = require('baileys');

const userSessions = new Map();
const salamKeywords = ["assalamualaikum", "asalamualaikum", "assalamu'alaikum", "aslm"];
const sapaanKeywords = ["halo", "hai", "pagi", "siang", "sore", "malam", "hallo", "hei", "hey", "bos", "bro", "gan"];

let botState = {
  status: true, // true = aktif, false = nonaktif
  admin: process.env.ADMIN_NUMBER, // Nomor admin dari environment variable
  lock: false, // Untuk mencegah perintah lain diproses bersamaan
  lastAction: new Date() // Waktu terakhir bot diupdate
};

// Fungsi untuk mengupload gambar ke Drive via Apps Script
async function uploadToDrive(filePath) {
  try {
    const imageBase64 = fs.readFileSync(filePath, 'base64');
    const response = await axios.post(
      process.env.APP_SCRIPT_URL,
      {
        action: "upload",
        file: imageBase64,
        fileName: `bukti_transfer_${Date.now()}.jpg`
      }
    );
    console.log("✅ File berhasil diupload:", response.data.fileUrl);
    return response.data.fileUrl;
  } catch (error) {
    console.error("❌ Gagal mengupload file:", error.response?.data || error.message);
    return null;
  }
}

// Fungsi untuk menangani pesan gambar
async function handleImageMessage(sock, message) {
  const sender = message.key.remoteJid;
  const mediaMessage = message.message?.imageMessage;

  if (!mediaMessage) {
    await sock.sendMessage(sender, { 
      text: "❌ Hanya gambar yang diterima sebagai bukti transfer. Silakan kirim ulang dalam format gambar." 
    });
    return;
  }

  const maxFileSize = 5 * 1024 * 1024; // 5 MB
  if (mediaMessage.fileLength > maxFileSize) {
    await sock.sendMessage(sender, { 
      text: "❌ Ukuran gambar terlalu besar. Maksimal 5 MB." 
    });
    return;
  }

  try {
    const buffer = await downloadMediaMessage(message, "buffer", {}, { logger: sock?.logger });
    const filePath = `./bukti_transfer/${Date.now()}.jpg`;
    fs.writeFileSync(filePath, buffer);

    const fileUrl = await uploadToDrive(filePath);
    await sock.sendMessage(sender, { 
      text: "✅ Bukti pembayaran telah diterima. Admin akan memverifikasi pembayaran Anda." 
    });

    await sock.sendMessage(process.env.ADMIN_NUMBER + '@s.whatsapp.net', {
      text: `📤 Bukti pembayaran dari ${sender} telah diterima. File tersedia di Google Drive: ${fileUrl}`
    });

    fs.unlinkSync(filePath);
  } catch (error) {
    console.error("Gagal mengunduh media:", error);
    await sock.sendMessage(sender, { 
      text: "⚠️ Gagal memproses bukti transfer. Silakan coba lagi." 
    });
  }
}

// Fungsi untuk menampilkan menu utama
async function showMainMenu(sock, sender) {
  await sock.sendMessage(sender, {
    text: "📌 Menu:\n.produk - Lihat produk\n.invoice - Buat pesanan\n.alamat - Info toko"
  });
}

// Fungsi untuk menangani perintah produk
async function handleProductCommand(sock, sender, session) {
  await sendProductList(sock, sender);
  userSessions.set(sender, { ...session, inProductList: true });
}

// Fungsi untuk kembali ke menu edit
const kembaliKeMenuEdit = async (sock, sender, session) => {
  session.invoiceState = 'AWAITING_EDIT_CHOICE';
  await sock.sendMessage(sender, {
    text: "🛒 Ingin mengubah yang mana?\n1. Ubah Nama\n2. Ubah Nomor Telepon\n3. Ubah Produk\n4. Ubah Alamat\n5. Kembali"
  });
  userSessions.set(sender, session);
};

// Fungsi untuk menangani pembayaran
const handlePayment = async (sock, sender, session) => {
  const invoiceId = session.previousInvoice?.id;
  if (!invoiceId) {
    await sock.sendMessage(sender, { text: "❌ Invoice tidak valid. Silakan coba lagi." });
    return;
  }

  await sock.sendMessage(sender, {
    text: "💳 Pilih metode pembayaran:\n1. Transfer Bank\n2. COD (Cash on Delivery)"
  });

  session.invoiceState = 'AWAITING_PAYMENT_METHOD';
  userSessions.set(sender, session);
};

// Fungsi untuk menampilkan detail invoice
const tampilkanDetailInvoice = async (sock, sender, invoice) => {
  try {
    // Debugging: Tampilkan status invoice dan state
    console.log("[DEBUG] Current State:", nextSession.invoiceState);
    console.log("[DEBUG] Shipping Status:", invoice.shippingStatus);

    // Format daftar produk
    const productList = invoice.items
      .map(
        (item) =>
          `${item.name} (${item.qty}x Rp${item.price.toLocaleString("id-ID")}) = Rp${item.subtotal.toLocaleString("id-ID")}`
      )
      .join("\n") || "Belum ada produk.";

    // Format detail invoice
    let detailInvoice = `📝 DETAIL INVOICE (${invoice.paymentStatus.toUpperCase()})\n➖➖➖➖➖➖➖➖➖➖\n`;
    detailInvoice += `ID: ${invoice.id}\n`;
    detailInvoice += `Nama: ${invoice.name}\n`;
    detailInvoice += `No. Telepon: ${invoice.phone}\n`;
    detailInvoice += `Alamat: ${invoice.address}\n\n`;
    detailInvoice += `Produk:\n${productList}\n\n`;
    detailInvoice += `Ongkir: ${invoice.shipping.originalCost} ${invoice.shipping.finalCost}\n`;
    detailInvoice += `Estimasi: ${invoice.shipping.estimate}\n`;

    // Tambahkan nomor resi jika status pengiriman "DIKIRIM"
    if (invoice.shippingStatus.toUpperCase() === "DIKIRIM") {
      detailInvoice += `Nomor Resi: ${invoice.shipping.resi || "Belum diisi"}\n`;
    }

    detailInvoice += `➖➖➖➖➖➖➖➖➖➖\nTOTAL: Rp${invoice.total.toLocaleString("id-ID")}\n\n`;

    // Tentukan opsi berdasarkan status invoice
    if (invoice.paymentStatus.toUpperCase() === "DRAFT") {
      detailInvoice += "Pilihan:\n1. Lanjut Pembayaran\n2. Ubah\n3. Hapus";
    } else if (invoice.shippingStatus.toUpperCase() === "DIKIRIM") {
      detailInvoice += "Pilihan:\n1. Cetak Invoice (PDF)\n2. Lacak Pengiriman\n3. Kembali";
    } else if (invoice.shippingStatus.toUpperCase() === "DITOLAK") {
      detailInvoice += "Pilihan:\n1. Proses Pengembalian Dana\n2. Kembali";
    } else {
      detailInvoice += "Pilihan:\n1. Cetak Invoice (PDF)\n2. Kembali";
    }

    // Kirim pesan ke pengguna
    await sock.sendMessage(sender, { text: detailInvoice });
  } catch (error) {
    console.error("Error dalam tampilkanDetailInvoice:", error);
    await sock.sendMessage(sender, { text: "⚠️ Gagal menampilkan detail invoice. Silakan coba lagi." });
  }
};

// Fungsi untuk menampilkan invoice sebelumnya
const tampilkanInvoiceSebelumnya = async (sock, sender, session) => {
  const invoice = session.previousInvoice;

  if (!invoice || !invoice.items) {
    await sock.sendMessage(sender, { text: "❌ Data invoice tidak valid atau tidak lengkap." });
    return;
  }

  const productList = invoice.items.map(item =>
    `${item.name} (${item.qty}x Rp${item.price.toLocaleString('id-ID')}) = Rp${item.subtotal.toLocaleString('id-ID')}`
  ).join('\n') || "Belum ada produk.";

  const invoiceDetail = `
📝 DETAIL INVOICE SEBELUMNYA
➖➖➖➖➖➖➖➖➖➖
ID Invoice: ${invoice.id}
Nama: ${invoice.name}
No. Telepon: ${invoice.phone}
Alamat: ${invoice.address}

Produk:
${productList}

Ongkir: ${invoice.shipping.originalCost} ${invoice.shipping.finalCost}
Estimasi: ${invoice.shipping.estimate}
➖➖➖➖➖➖➖➖➖➖
TOTAL: Rp${invoice.total.toLocaleString('id-ID')}

Pilihan:
1. Lanjut Pembayaran
2. Ubah
3. Simpan
4. Buat Invoice Baru
5. Hapus
  `;

  await sock.sendMessage(sender, { text: invoiceDetail });
  session.invoiceState = 'AWAITING_INVOICE_ACTION';
  userSessions.set(sender, session);
};

// Fungsi untuk menampilkan daftar invoice
const showDraftInvoices = async (sock, sender, invoices) => {
  if (invoices.length === 0) {
    await sock.sendMessage(sender, { text: "📭 Tidak ada invoice tersimpan." });
    return;
  }

  let invoiceList = "📝 Invoice yang tersimpan:\n";
  invoices.forEach((invoice, index) => {
    invoiceList += 
      `${index + 1}. ID: ${invoice.id}\n` +
      `   💵 *Pembayaran:* ${invoice.paymentStatus}\n` +
      `   🚚 *Pengiriman:* ${invoice.shippingStatus}\n\n`;
  });

  invoiceList += "\nPilihan:\n1. Kelola Invoice\n2. Buat invoice baru";
  await sock.sendMessage(sender, { text: invoiceList });

  const session = userSessions.get(sender) || { invoiceState: null };
  session.invoiceState = 'AWAITING_INVOICE_ACTION';
  userSessions.set(sender, session);
};

// Fungsi untuk menangani aksi invoice
const handleInvoiceAction = async (sock, sender, messageText, session) => {
  console.log("Memproses opsi:", messageText);

  const phoneNumber = sender.replace('@s.whatsapp.net', '');

  if (!phoneNumber) {
    await sock.sendMessage(sender, { text: "❌ Nomor telepon tidak valid." });
    return;
  }
  
  switch (messageText) {
    case '1': // Kelola Invoice
      const invoices = await getInvoicesByPhone(phoneNumber);
      if (invoices.length === 0) {
        await sock.sendMessage(sender, { text: "📭 Tidak ada invoice tersimpan." });
        return;
      }

      let invoiceList = "📝 Invoice yang tersimpan:\n";
      invoices.forEach((invoice, index) => {
        invoiceList += 
          `${index + 1}. ID: ${invoice.id}\n` +
          `   💵 *Pembayaran:* ${invoice.paymentStatus}\n` +
          `   🚚 *Pengiriman:* ${invoice.shippingStatus}\n\n`;
      });

      invoiceList += "\nKetik nomor invoice yang ingin Anda kelola.\nContoh: 1";
      await sock.sendMessage(sender, { text: invoiceList });

      session.invoiceState = 'AWAITING_INVOICE_SELECTION';
      userSessions.set(sender, session);
      break;

    case '2': // Buat Invoice Baru
      userSessions.set(sender, {
        invoiceState: 'AWAITING_NAME',
        invoiceData: {},
        previousInvoice: null
      });
      await sock.sendMessage(sender, {
        text: "🛒 MEMULAI PEMESANAN BARU\nSilakan masukkan nama Anda:"
      });
      break;

    default:
      await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid. Silakan ketik angka 1-2. Contoh: 1" });
  }
};

// Fungsi untuk menangani aksi draft
const handleDraftAction = async (sock, sender, messageText, nextSession) => {
  try {
    switch (messageText) {
      case '1': // Lanjut Pembayaran
        await sock.sendMessage(sender, {
          text: "💳 Pilih metode pembayaran:\n1. Transfer Bank (QRIS)\n2. COD (Cash on Delivery)"
        });
        nextSession.invoiceState = 'AWAITING_PAYMENT_METHOD';
        userSessions.set(sender, nextSession);
        break;

      case '2': // Ubah
        nextSession.invoiceState = 'AWAITING_EDIT_CHOICE';
        await sock.sendMessage(sender, {
          text: "🛒 Ingin mengubah yang mana?\n1. Ubah Nama\n2. Ubah Nomor Telepon\n3. Ubah Produk\n4. Ubah Alamat\n5. Kembali"
        });
        break;

      case '3': // Hapus
        await updateInvoiceStatus(nextSession.previousInvoice.id, "Dibatalkan", "Status_Pembayaran");
        await sock.sendMessage(sender, { text: "✅ Invoice berhasil dihapus." });
        userSessions.delete(sender);
        break;

      default:
        await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid" });
    }
  } catch (error) {
    console.error("Error dalam handleDraftAction:", error);
    await sock.sendMessage(sender, { text: `⚠️ Error: ${error.message}` });
  }
};

// Fungsi untuk menangani langkah invoice
const handleInvoiceStep = async (sock, sender, messageText, session) => {
  try {
    let nextSession = { ...session };
    const phoneNumber = sender.replace('@s.whatsapp.net', '');

    if (!phoneNumber) {
      throw new Error("Nomor telepon tidak ditemukan.");
    }

    console.log("Memproses pesan dengan state:", nextSession.invoiceState);

    switch (nextSession.invoiceState) {
      case 'AWAITING_NAME':
        console.log("Menerima nama:", messageText);
        nextSession.invoiceData.name = messageText;
        nextSession.invoiceData.phone = phoneNumber;
        nextSession.invoiceState = 'AWAITING_ADDRESS';
        await sock.sendMessage(sender, {
          text: "📍 MASUKKAN ALAMAT LENGKAP\nFormat: Desa, RT/RW, Kecamatan, Kabupaten\nContoh: Sambong, 02/03, Batang, Batang"
        });
        break;

      case 'AWAITING_ADDRESS': {
        const addressParts = messageText.split(',')
          .map(part => part.trim())
          .filter(part => part !== '');

          if (addressParts.length !== 4) {
            await sock.sendMessage(sender, {
              text: "❌ Maaf, format alamat yang Anda masukkan tidak valid. Pastikan formatnya:\nDesa, RT/RW, Kecamatan, Kabupaten\nContoh: *Sambong, 02/03, Batang, Batang*"
            });
            return;
          }

        const [village, rtRw, district, city] = addressParts;
        nextSession.invoiceData.village = village;
        nextSession.invoiceData.rtRw = rtRw;
        nextSession.invoiceData.district = district;
        nextSession.invoiceData.city = city;
        nextSession.invoiceState = 'AWAITING_PROVINCE';
        await sock.sendMessage(sender, { text: "📍 MASUKKAN PROVINSI\nContoh: Jawa Tengah" });
        break;
      }

      case 'AWAITING_PROVINCE': {
        try {
          const province = messageText;
          const kota = nextSession.invoiceData.city;
          const shipping = await checkShippingCost(province, kota);

          nextSession.invoiceData.address = [
            `Desa: ${nextSession.invoiceData.village}`,
            `RT/RW: ${nextSession.invoiceData.rtRw}`,
            `Kecamatan: ${nextSession.invoiceData.district}`,
            `Kota: ${nextSession.invoiceData.city}`,
            `Provinsi: ${province}`
          ].join(', ');

          nextSession.invoiceData.shipping = shipping;
          nextSession.invoiceState = 'AWAITING_PRODUCTS';
          await sock.sendMessage(sender, {
            text: "📋 MASUKKAN PRODUK\nFormat: [Nama Produk] [Jumlah]\nContoh:\nBurhanrex 2\nKaos Polos Pria 3"
          });
        } catch (error) {
          await sock.sendMessage(sender, { text: `⚠️ ${error.message}` });
        }
        break;
      }

      case 'AWAITING_PRODUCTS': {
        try {
          const { items, total } = await parseProductsInput(messageText);
          nextSession.invoiceData.products = {
            items: items.filter(item => item.qty > 0),
            total: items.reduce((sum, item) => sum + item.subtotal, 0)
          };
          nextSession.invoiceState = 'AWAITING_CONFIRMATION';
          await showInvoiceConfirmation(sock, sender, {
            ...nextSession.invoiceData,
            total: nextSession.invoiceData.products.total +
              (nextSession.invoiceData.shipping.finalCost === '*GRATIS*' ? 0 :
                parseInt(nextSession.invoiceData.shipping.finalCost.replace(/\D/g, '')))
          });
        } catch (error) {
          await sock.sendMessage(sender, { text: `⚠️ ${error.message}` });
        }
        break;
      }

      case 'AWAITING_DRAFT_ACTION':
        await handleDraftAction(sock, sender, messageText, nextSession);
        break;

      case 'AWAITING_PAYMENT_METHOD':
        switch (messageText) {
          case '1': // Transfer Bank (QRIS)
            await sock.sendMessage(sender, {
              image: { url: "https://drive.google.com/uc?export=download&id=1tFfX6h4tUG8Jo6Wa0Z9iwqBzdeDhzID9" },
              caption: "📷 Silakan scan QRIS berikut untuk melakukan pembayaran."
            });
            await sock.sendMessage(sender, {
              text: "🏦 Silakan lakukan transfer ke QRIS di atas.\nSetelah melakukan pembayaran, kirim bukti transfer ke admin."
            });
            await updateInvoiceStatus(nextSession.previousInvoice.id, "Menunggu Pembayaran", "Status_Pembayaran");
            userSessions.delete(sender);
            return;

          case '2': // COD
            await updateInvoiceStatus(nextSession.previousInvoice.id, "PENDING", "Status_Pembayaran");
            await sock.sendMessage(sender, {
              text: "🚚 Pesanan Anda akan diproses dengan metode COD. Pembayaran dilakukan saat paket diterima."
            });
            userSessions.delete(sender);
            return;

          default:
            await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid. Silakan ketik 1 atau 2." });
        }
        break;

      case 'AWAITING_CONFIRMATION':
        switch (messageText) {
          case '1': // Lanjut Pembayaran
            session.previousInvoice = {
              id: generateInvoiceId(),
              ...session.invoiceData
            };
            await handlePayment(sock, sender, session);
            break;

          case '2': // Ubah
            nextSession.invoiceState = 'AWAITING_EDIT_CHOICE';
            await sock.sendMessage(sender, {
              text: "🛒 Ingin mengubah yang mana?\n1. Ubah Nama\n2. Ubah Nomor Telepon\n3. Ubah Produk\n4. Ubah Alamat\n5. Kembali"
            });
            break;

          case '3': // Simpan
            try {
              const response = await saveInvoiceToSheet(nextSession.invoiceData);
              await sock.sendMessage(sender, {
                text: `✅ Invoice disimpan. ID: ${response.idPesanan}`
              });
              userSessions.delete(sender);
              return;
            } catch (error) {
              await sock.sendMessage(sender, { text: `⚠️ Gagal menyimpan: ${error.message}` });
            }
            break;

          case '4': // Hapus
            userSessions.delete(sender);
            await sock.sendMessage(sender, { text: "❌ Invoice dibatalkan" });
            return;

          default:
            await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid. Silakan ketik angka 1-4. Contoh: 1" });
        }
        break;

      case 'AWAITING_PAYMENT_PROOF':
        if (message.message?.imageMessage) {
          await handleImageMessage(sock, message);
          userSessions.delete(sender);
        } else {
          userSessions.delete(sender);
          await module.exports(sock, message);
        }
        break;

      case 'AWAITING_EDIT_CHOICE':
        switch (messageText) {
          case '1': // Ubah Nama
            nextSession.invoiceState = 'AWAITING_NEW_NAME';
            await sock.sendMessage(sender, { text: "🛒 Masukkan nama baru:" });
            break;

          case '2': // Ubah Nomor Telepon
            nextSession.invoiceState = 'AWAITING_NEW_PHONE';
            await sock.sendMessage(sender, { text: "📞 Masukkan nomor telepon baru:" });
            break;

          case '3': // Ubah Produk
            nextSession.invoiceState = 'AWAITING_NEW_PRODUCTS';
            await sock.sendMessage(sender, {
              text: "📋 Masukkan produk baru:\nFormat: [Nama Produk] [Jumlah]"
            });
            break;

          case '4': // Ubah Alamat
            nextSession.invoiceState = 'AWAITING_NEW_ADDRESS';
            await sock.sendMessage(sender, {
              text: "📍 Masukkan alamat baru:\nContoh: Sambong, 02/03, Batang, Batang"
            });
            break;

          case '5': // Kembali
            nextSession.invoiceState = 'AWAITING_CONFIRMATION';
            await showInvoiceConfirmation(sock, sender, nextSession.invoiceData);
            break;

          default:
            await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid. Silakan ketik angka 1-5. Contoh: 1" });
        }
        break;

      case 'AWAITING_NEW_NAME':
        nextSession.invoiceData.name = messageText;
        await kembaliKeMenuEdit(sock, sender, nextSession);
        break;

      case 'AWAITING_NEW_PHONE': {
        const newPhone = messageText.replace(/\D/g, '');
        if (newPhone.length < 10) {
          await sock.sendMessage(sender, { text: "⚠️ Maaf, nomor telepon yang Anda masukkan tidak valid. Pastikan nomor telepon terdiri dari 10-13 digit angka. Contoh: 081234567890." });
          return;
        }
        nextSession.invoiceData.phone = newPhone;
        await kembaliKeMenuEdit(sock, sender, nextSession);
        break;
      }

      case 'AWAITING_NEW_ADDRESS': {
        const addressParts = messageText.split(',')
          .map(part => part.trim())
          .filter(part => part !== '');

        if (addressParts.length !== 4) {
          await sock.sendMessage(sender, { text: "❌ Maaf, format alamat yang Anda masukkan tidak valid. Pastikan formatnya:\nDesa, RT/RW, Kecamatan, Kabupaten\nContoh: *Sambong, 02/03, Batang, Batang*" });
          return;
        }

        const [village, rtRw, district, city] = addressParts;
        nextSession.invoiceData.address = [
          `Desa: ${village}`, `RT/RW: ${rtRw}`,
          `Kecamatan: ${district}`, `Kota: ${city}`
        ].join(', ');
        // Pindah ke state baru untuk meminta provinsi
  nextSession.invoiceState = 'AWAITING_NEW_PROVINCE';
  await sock.sendMessage(sender, { 
    text: "📍 MASUKKAN PROVINSI BARU\nContoh: Jawa Tengah" 
  });
        break;
      }
      case 'AWAITING_NEW_PROVINCE': {
        try {
          const newProvince = messageText;
          const shipping = await checkShippingCost(newProvince);
          
          // Update data
          nextSession.invoiceData.shipping = shipping;
          nextSession.invoiceData.address += `, Provinsi: ${newProvince}`;
          
          // Kembali ke menu edit
          await kembaliKeMenuEdit(sock, sender, nextSession);
        } catch (error) {
          await sock.sendMessage(sender, { 
            text: `⚠️ Error: ${error.message}` 
          });
        }
        break;
      }

      case 'AWAITING_NEW_PRODUCTS': {
        try {
          const { items: newItems } = await parseProductsInput(messageText);
          const existingItems = nextSession.invoiceData.products.items;

          for (const newItem of newItems) {
            const index = existingItems.findIndex(i => i.name.toLowerCase() === newItem.name.toLowerCase());
            if (index !== -1) {
              newItem.qty === 0 ? existingItems.splice(index, 1) : existingItems[index].qty = newItem.qty;
            } else if (newItem.qty > 0) {
              existingItems.push(newItem);
            }
          }

          nextSession.invoiceData.products.items = existingItems.filter(i => i.qty > 0);
          nextSession.invoiceData.products.total = existingItems.reduce((sum, i) => sum + i.subtotal, 0);
          await kembaliKeMenuEdit(sock, sender, nextSession);
        } catch (error) {
          await sock.sendMessage(sender, { text: `⚠️ ${error.message}` });
        }
        break;
      }

      case 'AWAITING_INVOICE_SELECTION': {
        try {
          // Debugging: Tampilkan state saat ini
          console.log("[DEBUG] Current State: AWAITING_INVOICE_SELECTION");
      
          // Ambil nomor telepon pengguna
          const phoneNumber = sender.replace('@s.whatsapp.net', '');
          if (!phoneNumber) {
            throw new Error("Nomor telepon tidak valid.");
          }
      
          // Ambil daftar invoice berdasarkan nomor telepon
          const invoices = await getInvoicesByPhone(phoneNumber);
          console.log("[DEBUG] Invoices Found:", invoices.length);
      
          // Validasi input pengguna
          const selectedIndex = parseInt(messageText) - 1;
          if (isNaN(selectedIndex)) {
            await sock.sendMessage(sender, { text: "❌ Input tidak valid. Harap masukkan angka." });
            return;
          }
      
          if (selectedIndex < 0 || selectedIndex >= invoices.length) {
            await sock.sendMessage(sender, { text: "❌ Nomor invoice tidak valid." });
            return;
          }
      
          // Ambil invoice yang dipilih
          const selectedInvoice = invoices[selectedIndex];
          console.log("[DEBUG] Selected Invoice ID:", selectedInvoice.id);
          console.log("[DEBUG] Selected Invoice Status:", selectedInvoice.shippingStatus);
      
          // Simpan invoice yang dipilih ke session
          nextSession.previousInvoice = selectedInvoice;
      
          // Tentukan state berdasarkan status pengiriman
          if (selectedInvoice.shippingStatus.toUpperCase() === "DIKIRIM") {
            nextSession.invoiceState = 'AWAITING_SHIPPING_ACTION';
            console.log("[DEBUG] Transitioning to AWAITING_SHIPPING_ACTION");
          } else {
            nextSession.invoiceState = 'AWAITING_DRAFT_ACTION';
            console.log("[DEBUG] Transitioning to AWAITING_DRAFT_ACTION");
          }
      
          // Tampilkan detail invoice
          await tampilkanDetailInvoice(sock, sender, selectedInvoice);
      
          // Update session
          userSessions.set(sender, nextSession);
        } catch (error) {
          console.error("Error dalam AWAITING_INVOICE_SELECTION:", error);
          await sock.sendMessage(sender, { text: `⚠️ Error: ${error.message}` });
        }
        break;
      }

      case 'AWAITING_SHIPPING_ACTION': {
        switch (messageText) {
          case '1': // Cetak Invoice
          try {
            // Tambahkan pengecekan invoice
            if (!nextSession.previousInvoice) {
              throw new Error("Invoice tidak ditemukan");
            }
    
            // Generate PDF
            const pdfBuffer = await generateInvoicePDF(nextSession.previousInvoice);
            
            // Kirim PDF
            await sock.sendMessage(sender, {
              document: pdfBuffer,
              mimetype: 'application/pdf',
              fileName: `Invoice_${nextSession.previousInvoice.id}.pdf`
            });
            
            // Beri konfirmasi
            await sock.sendMessage(sender, { 
              text: "✅ Invoice PDF berhasil dikirim. Ketik .menu untuk kembali ke menu utama" 
            });
    
            // Reset session setelah PDF dikirim
        userSessions.delete(sender); // Hapus session pengguna
        return; // Keluar dari fungsi setelah PDF dikirim
    
          } catch (error) {
            console.error("Gagal membuat PDF:", error);
            await sock.sendMessage(sender, { 
              text: `⚠️ Gagal membuat invoice: ${error.message}` 
            });
          }
          break;
      
          case '2': // Lacak Pengiriman
            if (nextSession.previousInvoice.shipping.resi) {
              await sock.sendMessage(sender, { text: `🚚 INFO PELACAKAN (Resi: ${nextSession.previousInvoice.shipping.resi})\nStatus: Paket sedang dalam perjalanan.\nEstimasi: ${nextSession.previousInvoice.shipping.estimate}` });
            } else {
              await sock.sendMessage(sender, { text: "❌ Nomor resi belum tersedia. Silakan hubungi admin." });
            }
            break;
      
          case '3': // Kembali
            nextSession.invoiceState = 'AWAITING_INVOICE_ACTION';
            await handleInvoiceAction(sock, sender, '1', nextSession);
            break;
      
          default:
            await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid" });
        }
        break;
      }

      case 'AWAITING_DRAFT_ACTION':
        switch (messageText) {
          case '1': // Ubah
            nextSession.invoiceState = 'AWAITING_EDIT_CHOICE';
            await sock.sendMessage(sender, {
              text: "🛒 Ingin mengubah yang mana?\n1. Ubah Nama\n2. Ubah Nomor Telepon\n3. Ubah Produk\n4. Ubah Alamat\n5. Kembali"
            });
            break;

          case '2': // Hapus
            await updateInvoiceStatus(session.previousInvoice.id, "Dibatalkan");
            await sock.sendMessage(sender, { text: "✅ Invoice berhasil dihapus." });
            userSessions.delete(sender);
            return;

          case '3': // Lanjut ke Pembayaran
            await updateInvoiceStatus(session.previousInvoice.id, "Proses Pembayaran");
            await sock.sendMessage(sender, { text: "✅ Invoice berhasil diproses. Silakan lanjutkan pembayaran." });
            userSessions.delete(sender);
            return;

          case '4': // Kembali
            session.invoiceState = 'AWAITING_INVOICE_ACTION';
            await handleInvoiceAction(sock, sender, '1', session);
            return;

          default:
            await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid" });
        }
        break;
    }

    userSessions.set(sender, nextSession);
  } catch (error) {
    console.error("Error:", error);
    await sock.sendMessage(sender, { text: `⚠️ Error: ${error.message}` });
    userSessions.set(sender, { ...session, invoiceState: null });
  }
};

async function handleInvoiceCommand(sock, sender) {
  const phone = sender.replace('@s.whatsapp.net', '');
  const invoices = await getInvoicesByPhone(phone);

  if (invoices.length > 0) {
    await showDraftInvoices(sock, sender, invoices);
  } else {
    userSessions.set(sender, {
      invoiceState: 'AWAITING_NAME',
      invoiceData: {}
    });
    await sock.sendMessage(sender, {
      text: "🛒 MEMULAI PEMESANAN\nSilakan masukkan nama Anda:"
    });
  }
}

// Fungsi utama untuk menangani pesan
async function handleMessage(sock, message) {
  const sender = message.key.remoteJid;
  const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text || '';

  // Handle pesan admin terlebih dahulu
  if (await handleAdminMessage(sock, message)) {
    console.log(`[ADMIN] Pesan admin ditangani - Status: ${isBotActive()}`);
    return;
  }

  // Jika bot nonaktif, hanya admin yang bisa mengirim perintah
  if (!isBotActive() && sender !== botState.admin + '@s.whatsapp.net') {
    await sock.sendMessage(sender, {
      text: "❌ Bot sedang nonaktif. Silakan hubungi admin untuk mengaktifkan kembali."
    });
    return;
  }

  // Handle pesan gambar
  if (message.message?.imageMessage) {
    await handleImageMessage(sock, message);
    return;
  }

  // Inisialisasi session
  let session = userSessions.get(sender) || {
    invoiceState: null,
    invoiceData: {},
    previousInvoice: null,
    inProductList: false
  };

  // Handle state khusus
  if (session.invoiceState === 'AWAITING_PAYMENT_PROOF') {
    await sock.sendMessage(sender, { 
      text: "❌ Kirim bukti transfer dalam format gambar." 
    });
    return;
  }

  if (session.invoiceState === 'AWAITING_INVOICE_ACTION') {
    await handleInvoiceAction(sock, sender, messageText, session);
    return;
  }

  if (session.invoiceState) {
    await handleInvoiceStep(sock, sender, messageText, session);
    return;
  }

  // Handle perintah umum
  const lowerMessage = messageText.toLowerCase();
  
  if (/^\. ?invoice$/i.test(messageText)) {
    await handleInvoiceCommand(sock, sender);
    return;
  }

  if (salamKeywords.some(kw => lowerMessage.includes(kw))) {
    await sock.sendMessage(sender, {
      text: "Waalaikumsalam Bosku, Saya adalah bot pembantu Anda. Saya bisa membantu Anda membuat invoice, melihat produk, dan mengelola pesanan. Ketik *.menu* untuk melihat opsi yang tersedia."
    });
    return;
  }
  if (sapaanKeywords.some(kw => lowerMessage.includes(kw))) {
    await sock.sendMessage(sender, {
      text: "Halo Bosku, Saya adalah bot pembantu Anda. Saya bisa membantu Anda membuat invoice, melihat produk, dan mengelola pesanan. Ketik *.menu* untuk melihat opsi yang tersedia."
    });
    return;
  }

  if (/^\. ?menu$/i.test(messageText)) {
    await showMainMenu(sock, sender);
    return;
  }

  if (/^\. ?produk$/i.test(messageText)) {
    await handleProductCommand(sock, sender, session);
    return;
  }

  if (session.inProductList) {
    await sendProductDetail(sock, sender, messageText);
    userSessions.set(sender, { ...session, inProductList: false });
    return;
  }
  return;
}

module.exports = {
  handleMessage,
  handleImageMessage,
  uploadToDrive,
  handleInvoiceAction,
  handleInvoiceStep,
  handleInvoiceCommand 
};
