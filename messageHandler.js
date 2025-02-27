const { sendProductList, sendProductDetail, getProducts } = require('./productHandler');
const { handleAdminMessage, isBotActive } = require('./adminHandler');
const { saveInvoiceToSheet, waitForUserResponse, checkShippingCost, parseProductsInput, showInvoiceConfirmation } = require('./invoiceHandler');

const userSessions = new Map();
const salamKeywords = ["assalamualaikum", "asalamualaikum", "assalamu'alaikum", "aslm"];
const sapaanKeywords = ["halo", "hai", "pagi", "siang", "sore", "malam", "hallo", "hei", "hey", "bos", "bro", "gan"];

// Fungsi untuk menangani langkah-langkah invoice
const handleInvoiceStep = async (sock, sender, messageText, session) => {
  try {
    console.log("[1] Current session before update:", session); // Log session sebelum di-update

    let nextSession = { ...session }; // Salin session saat ini

    // Ambil nomor telepon dari sender
    const phoneNumber = sender.replace('@s.whatsapp.net', ''); // <-- INI DIPINDAHKAN KE ATAS
    console.log("Nomor telepon pengirim:", phoneNumber); // Log nomor telepon

    // Pastikan phoneNumber tidak kosong
    if (!phoneNumber) {
      throw new Error("Nomor telepon tidak ditemukan. Pastikan nomor telepon sudah diambil dari sender.");
    }

    switch (nextSession.invoiceState) {
      case 'AWAITING_NAME':
        nextSession.invoiceData.name = messageText;
        nextSession.invoiceData.phone = phoneNumber; // Simpan nomor telepon otomatis
        
        // Jika sudah ada produk dan alamat, langsung kembali ke konfirmasi
        if (nextSession.invoiceData.products && nextSession.invoiceData.address) {
          nextSession.invoiceState = 'AWAITING_CONFIRMATION';
          await showInvoiceConfirmation(sock, sender, {
            ...nextSession.invoiceData,
            total: nextSession.invoiceData.products.total +
              (nextSession.invoiceData.shipping.finalCost === '*GRATIS*' ? 0 :
                parseInt(nextSession.invoiceData.shipping.finalCost.replace(/\D/g, '')))
          });
        } else {
          nextSession.invoiceState = 'AWAITING_PRODUCTS';
          await sock.sendMessage(sender, {
            text: "📋 *MASUKKAN PRODUK*\nFormat: [Nama Produk] [Jumlah]\nContoh:\nBurhanrex 2\nKaos Polos Pria 3\n\nAnda dapat memasukkan lebih dari satu produk dalam satu pesan."
          });
        }
        console.log("[4] Bot mengirim pesan:", "📋 *MASUKKAN PRODUK*");
        break;

      case 'AWAITING_PRODUCTS': {
        try {
          // Proses input produk (bisa lebih dari satu baris)
          const { items, total } = await parseProductsInput(messageText);
          nextSession.invoiceData.products = {
            items: items.filter(item => item.qty > 0),
            total: items.filter(item => item.qty > 0).reduce((sum, item) => sum + item.subtotal, 0)
          };

          // Jika sudah ada alamat, langsung kembali ke konfirmasi
          if (nextSession.invoiceData.address) {
            nextSession.invoiceState = 'AWAITING_CONFIRMATION';
            await showInvoiceConfirmation(sock, sender, {
              ...nextSession.invoiceData,
              total: nextSession.invoiceData.products.total +
                (nextSession.invoiceData.shipping.finalCost === '*GRATIS*' ? 0 :
                  parseInt(nextSession.invoiceData.shipping.finalCost.replace(/\D/g, '')))
            });
          } else {
            nextSession.invoiceState = 'AWAITING_VILLAGE';
            await sock.sendMessage(sender, {
              text: "📍 *MASUKKAN DESA*\nContoh: Sambong"
            });
          }
          console.log("[4] Bot mengirim pesan:", "📍 *MASUKKAN DESA*");
        } catch (error) {
          await sock.sendMessage(sender, {
            text: `⚠️ ${error.message}\n📋 Silakan masukkan produk lagi:`
          });
          return;
        }
        break;
      }

      case 'AWAITING_VILLAGE':
        nextSession.invoiceData.village = messageText;
        nextSession.invoiceState = 'AWAITING_RT_RW';
        await sock.sendMessage(sender, { text: "📍 *MASUKKAN RT/RW*\nContoh: 02/03" });
        console.log("[4] Bot mengirim pesan:", "📍 *MASUKKAN RT/RW*");
        break;

      case 'AWAITING_RT_RW': {
        // Validasi format RT/RW (harus angka/angka)
        const rtRwRegex = /^\d{1,3}\/\d{1,3}$/;
        if (!rtRwRegex.test(messageText)) {
          await sock.sendMessage(sender, {
            text: "⚠️ Format RT/RW tidak valid. Harus dalam format angka/angka.\nContoh: 02/03"
          });
          return;
        }
        nextSession.invoiceData.rtRw = messageText;
        nextSession.invoiceState = 'AWAITING_DISTRICT';
        await sock.sendMessage(sender, { text: "📍 *MASUKKAN KECAMATAN*\nContoh: Batang" });
        console.log("[4] Bot mengirim pesan:", "📍 *MASUKKAN KECAMATAN*");
        break;
      }

      case 'AWAITING_DISTRICT':
        nextSession.invoiceData.district = messageText;
        nextSession.invoiceState = 'AWAITING_CITY';
        await sock.sendMessage(sender, { text: "📍 *MASUKKAN KOTA/KABUPATEN*\nContoh: Batang" });
        console.log("[4] Bot mengirim pesan:", "📍 *MASUKKAN KOTA/KABUPATEN*");
        break;

      case 'AWAITING_CITY':
        nextSession.invoiceData.city = messageText;
        nextSession.invoiceState = 'AWAITING_PROVINCE';
        await sock.sendMessage(sender, { text: "📍 *MASUKKAN PROVINSI*\nContoh: Jawa Tengah" });
        console.log("[4] Bot mengirim pesan:", "📍 *MASUKKAN PROVINSI*");
        break;

        case 'AWAITING_PROVINCE': {
          try {
            const province = messageText;
            const shipping = await checkShippingCost(province);
        
            nextSession.invoiceData.address = [
              `Desa: ${nextSession.invoiceData.village}`,
              `RT/RW: ${nextSession.invoiceData.rtRw}`,
              `Kecamatan: ${nextSession.invoiceData.district}`,
              `Kota: ${nextSession.invoiceData.city}`,
              `Provinsi: ${province}`
            ].join(', ');
        
            nextSession.invoiceData.shipping = shipping;
            nextSession.invoiceState = 'AWAITING_CONFIRMATION';
        
            // Pastikan products sudah diisi
            if (!nextSession.invoiceData.products?.total) {
              throw new Error("Produk belum dimasukkan.");
            }
        
            // Hitung totalCost
            const totalCost = nextSession.invoiceData.products.total + 
              (nextSession.invoiceData.shipping.finalCost === '*GRATIS*' ? 0 : 
                parseInt(nextSession.invoiceData.shipping.finalCost.replace(/\D/g, '')));
        
            // Tampilkan konfirmasi invoice
            await showInvoiceConfirmation(sock, sender, {
              ...nextSession.invoiceData,
              total: totalCost // <-- Pastikan ini dikirim
            });
          } catch (error) {
            await sock.sendMessage(sender, {
              text: `⚠️ ${error.message}\n📍 Silakan masukkan provinsi lagi:`
            });
            return;
          }
          break;
        }

      case 'AWAITING_CONFIRMATION':
        switch (messageText) {
          case '1': // Lanjut Pembayaran
            await sock.sendMessage(sender, { text: "🔗 Mengarahkan ke menu pembayaran..." });
            break;

          case '2': // Ubah
            nextSession.invoiceState = 'AWAITING_EDIT_CHOICE';
            await sock.sendMessage(sender, {
              text: "🛒 *Ingin mengubah yang mana?*\n1. Ubah Nama\n2. Ubah Nomor Telepon\n3. Ubah Produk\n4. Ubah Alamat\n5. Batal"
            });
            break;

            case '3': // Simpan
            try {
              const response = await saveInvoiceToSheet(nextSession.invoiceData);
              await sock.sendMessage(sender, { 
                text: `✅ Invoice berhasil disimpan ke database.\n📁 ID Invoice: ${response.idPesanan}`
              });
            } catch (error) {
              await sock.sendMessage(sender, { 
                text: "⚠️ Gagal menyimpan invoice: " + error.message 
              });
            }
            break;
            
          case '4': // Batal
            await sock.sendMessage(sender, { text: "❌ Invoice dibatalkan" });
            userSessions.delete(sender);
            return;

          default:
            await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid. Silakan pilih 1-4." });
            return;
        }
        break;

      case 'AWAITING_EDIT_CHOICE':
        switch (messageText) {
          case '1': // Ubah Nama
            nextSession.invoiceState = 'AWAITING_NAME';
            await sock.sendMessage(sender, { text: "🛒 Silakan masukkan nama baru:" });
            break;

          case '2': // Ubah Nomor Telepon
            nextSession.invoiceState = 'AWAITING_PHONE';
            await sock.sendMessage(sender, { text: "📞 Silakan masukkan nomor telepon baru:" });
            break;

          case '3': // Ubah Produk
            nextSession.invoiceState = 'AWAITING_NEW_PRODUCTS';
            await sock.sendMessage(sender, {
              text: "📋 Silakan masukkan produk baru:\nFormat: [Nama Produk] [Jumlah]\nKetik jumlah 0 untuk menghapus produk."
            });
            break;

          case '4': // Ubah Alamat
            nextSession.invoiceState = 'AWAITING_VILLAGE';
            await sock.sendMessage(sender, { text: "📍 Silakan masukkan desa baru:" });
            break;

            case '5': // Batal
            // Kembali ke konfirmasi tanpa validasi tambahan
            nextSession.invoiceState = 'AWAITING_CONFIRMATION';
            await showInvoiceConfirmation(sock, sender, nextSession.invoiceData);
            break;

          default:
            await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid. Silakan pilih 1-5." });
            return;
        }
        break;

      case 'AWAITING_NEW_PRODUCTS': {
        try {
          // Parse input produk baru
          const { items: newItems } = await parseProductsInput(messageText);
          const existingItems = nextSession.invoiceData.products.items;

          // Proses setiap produk baru
          for (const newItem of newItems) {
            const existingItemIndex = existingItems.findIndex(item => 
              item.name.toLowerCase() === newItem.name.toLowerCase()
            );

            if (existingItemIndex !== -1) {
              // Jika produk sudah ada
              if (newItem.qty === 0) {
                // Jika jumlah 0, hapus produk
                existingItems.splice(existingItemIndex, 1);
              } else {
                // Jika jumlah bukan 0, update jumlah
                existingItems[existingItemIndex].qty = newItem.qty;
                existingItems[existingItemIndex].subtotal = existingItems[existingItemIndex].price * newItem.qty;
              }
            } else if (newItem.qty !== 0) {
              // Jika produk belum ada dan jumlah bukan 0, tambahkan produk baru
              existingItems.push(newItem);
            }
          }

          // Update data produk
          nextSession.invoiceData.products.items = existingItems.filter(item => item.qty > 0); // Hapus produk dengan jumlah 0
          nextSession.invoiceData.products.total = existingItems.reduce((sum, item) => sum + item.subtotal, 0);

          // Kembali ke konfirmasi invoice
          nextSession.invoiceState = 'AWAITING_CONFIRMATION';
          await showInvoiceConfirmation(sock, sender, {
            ...nextSession.invoiceData,
            total: nextSession.invoiceData.products.total +
              (nextSession.invoiceData.shipping.finalCost === '*GRATIS*' ? 0 :
                parseInt(nextSession.invoiceData.shipping.finalCost.replace(/\D/g, '')))
          });
        } catch (error) {
          await sock.sendMessage(sender, { text: `⚠️ Error: ${error.message}` });
        }
        break;
      }

      case 'AWAITING_NAME':
        nextSession.invoiceData.name = messageText;
        nextSession.invoiceState = 'AWAITING_CONFIRMATION';
        await showInvoiceConfirmation(sock, sender, nextSession.invoiceData);
        break;

      case 'AWAITING_PHONE':
        // Validasi nomor telepon (opsional)
        const newPhoneNumber = messageText.replace(/\D/g, ''); // Hapus karakter non-angka
        if (newPhoneNumber.length < 10) {
          await sock.sendMessage(sender, { 
            text: "⚠️ Nomor telepon tidak valid. Silakan masukkan nomor telepon yang benar."
          });
          return;
        }
        nextSession.invoiceData.phone = newPhoneNumber;
        nextSession.invoiceState = 'AWAITING_CONFIRMATION';
        await showInvoiceConfirmation(sock, sender, nextSession.invoiceData);
        break;

      case 'AWAITING_VILLAGE':
        nextSession.invoiceData.village = messageText;
        nextSession.invoiceState = 'AWAITING_RT_RW';
        await sock.sendMessage(sender, { text: "📍 *MASUKKAN RT/RW*\nContoh: 02/02" });
        break;
    }

    // Simpan session terbaru ke userSessions
    userSessions.set(sender, nextSession);
  } catch (error) {
    console.error("Error in handleInvoiceStep:", error);
    await sock.sendMessage(sender, { text: `⚠️ Error: ${error.message}` });
    userSessions.set(sender, { ...session, invoiceState: null });
  }
};

// Handler utama untuk pesan
module.exports = async (sock, message) => {
  const sender = message.key.remoteJid;
  const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text;

  if (!messageText) return;

  await handleAdminMessage(sock, message); // Handle pesan admin terlebih dahulu

  if (!isBotActive()) {
    return;
  }

  // Ambil session pengguna
  let session = userSessions.get(sender) || { invoiceState: null, invoiceData: {} };

  console.log("Current session before processing:", session); // Log session sebelum diproses

  // Konversi pesan ke huruf kecil agar lebih mudah dideteksi
  const lowerMessage = messageText.toLowerCase();

  // 1️⃣ Cek salam
  if (salamKeywords.some(salam => lowerMessage.includes(salam))) {
    await sock.sendMessage(sender, {
      text: "Waalaikumsalam, selamat datang di toko kami.\nUntuk melihat daftar produk kami, silakan ketik *.produk* atau *.menu* untuk melihat menu lainnya."
    });
    userSessions.set(sender, { ...session, inProductList: false });
    return;
  }

  // 2️⃣ Cek pesan pertama kali
  if (!userSessions.has(sender)) {
    userSessions.set(sender, {
      inProductList: false,
      invoiceState: null,
      invoiceData: {}
    });
    await sock.sendMessage(sender, {
      text: 'Halo, selamat datang di toko kami.\nUntuk melihat daftar produk kami, silakan ketik *.produk* atau *.menu* untuk melihat menu lainnya.'
    });
    return;
  }

  // 3️⃣ Cek sapaan
  if (sapaanKeywords.some(sapaan => lowerMessage.includes(sapaan))) {
    await sock.sendMessage(sender, {
      text: "Ya Bos, ada yang bisa kami bantu?\nUntuk melihat daftar produk kami, silakan ketik *.produk* atau *.menu* untuk melihat menu lainnya."
    });
    userSessions.set(sender, { ...session, inProductList: false });
    return;
  }

  // 4️⃣ Cek perintah .menu
  if (/^\. ?menu$/i.test(messageText)) {
    const menuText = `
📌 *Menu Utama:*
🛒 *.produk* - Lihat daftar produk
📍 *.alamat* - Melihat alamat toko
📄 *.invoice* - Buat invoice
💰 *.pembayaran* - Pilih metode pembayaran
🚚 *.cekpesanan* - Lihat status pesanan
👨💻 *.adminpesanan* - (Admin) Lihat daftar pesanan
    `;
    await sock.sendMessage(sender, { text: menuText });
    userSessions.set(sender, { ...session, inProductList: false });
    return;
  }

  // 5️⃣ Cek perintah .alamat
  if (/^\. ?alamat$/i.test(messageText)) {
    const alamatToko = `📌 *OBAT KUAT ASLI – 100% ORIGINAL & BERGARANSI!*
    // ... (isi pesan alamat toko)
    `;
    await sock.sendMessage(sender, { text: alamatToko });
    userSessions.set(sender, { ...session, inProductList: false });
    return;
  }

  // 6️⃣ Cek perintah .produk
  if (/^\.?(produk|list)$/i.test(messageText)) {
    await sendProductList(sock, sender);
    userSessions.set(sender, { ...session, inProductList: true });
    return;
  }

  // 8️⃣ Handle permintaan detail produk jika dalam mode product list
  if (session.inProductList) {
    await sendProductDetail(sock, sender, messageText);
    userSessions.set(sender, { ...session, inProductList: false });
    return;
  }

  // 7️⃣ Cek perintah .invoice
  if (/^\. ?invoice$/i.test(messageText)) {
    userSessions.set(sender, {
      invoiceState: 'AWAITING_NAME', // Mulai proses invoice
      invoiceData: {} // Reset data invoice
    });
    await sock.sendMessage(sender, {
      text: "🛒 *MEMULAI PEMESANAN*\nSilakan masukkan nama Anda:"
    });
    return;
  }

  // Jika ada invoiceState, lanjutkan ke handleInvoiceStep
  if (session.invoiceState) {
    await handleInvoiceStep(sock, sender, messageText, session);
    return;
  }
};
