const { sendProductList, sendProductDetail, getProducts } = require('./productHandler');
const { handleAdminMessage, isBotActive } = require('./adminHandler');
const { saveInvoiceToSheet, waitForUserResponse, checkShippingCost, parseProductsInput, showInvoiceConfirmation } = require('./invoiceHandler');

const userSessions = new Map();
const salamKeywords = ["assalamualaikum", "asalamualaikum", "assalamu'alaikum", "aslm"];
const sapaanKeywords = ["halo", "hai", "pagi", "siang", "sore", "malam", "hallo", "hei", "hey", "bos", "bro", "gan"];

const kembaliKeMenuEdit = async (sock, sender, session) => {
  session.invoiceState = 'AWAITING_EDIT_CHOICE';
  await sock.sendMessage(sender, {
    text: "🛒 Ingin mengubah yang mana?\n1. Ubah Nama\n2. Ubah Nomor Telepon\n3. Ubah Produk\n4. Ubah Alamat\n5. Kembali"
  });
};

const tampilkanInvoiceSebelumnya = async (sock, sender, session) => {
  const invoice = session.previousInvoice;
  const productList = invoice.products.items.map(item =>
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
TOTAL: Rp${invoice.products.total + (invoice.shipping.finalCost === '*GRATIS*' ? 0 : parseInt(invoice.shipping.finalCost.replace(/\D/g, ''))).toLocaleString('id-ID')}

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

const handleInvoiceAction = async (sock, sender, messageText, session) => {
  switch (messageText) {
    case '1':
      await sock.sendMessage(sender, { text: "🔗 Mengarahkan ke menu pembayaran..." });
      userSessions.delete(sender); // Hapus sesi setelah memilih opsi
      console.log(`Sesi dihapus untuk pengguna: ${sender}`); // Log untuk debugging
      break;
    case '2':
      session.invoiceState = 'AWAITING_EDIT_CHOICE';
      await sock.sendMessage(sender, {
        text: "🛒 Ingin mengubah yang mana?\n1. Ubah Nama\n2. Ubah Nomor Telepon\n3. Ubah Produk\n4. Ubah Alamat\n5. Kembali"
      });
      break;
    case '3':
      try {
        const response = await saveInvoiceToSheet(session.previousInvoice);
        await sock.sendMessage(sender, { 
          text: `✅ Invoice diperbarui. ID: ${response.idPesanan}` 
        });
        userSessions.delete(sender); // Hapus sesi setelah menyimpan invoice
        console.log(`Sesi dihapus untuk pengguna: ${sender}`); // Log untuk debugging
      } catch (error) {
        await sock.sendMessage(sender, { text: "⚠️ Gagal menyimpan: " + error.message });
      }
      break;
    case '4':
      userSessions.set(sender, { 
        invoiceState: 'AWAITING_NAME', 
        invoiceData: {},
        previousInvoice: null 
      });
      await sock.sendMessage(sender, { 
        text: "🛒 MEMULAI PEMESANAN BARU\nSilakan masukkan nama Anda:" 
      });
      break;
    case '5':
      delete session.previousInvoice;
      userSessions.set(sender, session);
      await sock.sendMessage(sender, { text: "❌ Invoice sebelumnya telah dihapus." });
      break;
    default:
      await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid" });
  }
};

const handleInvoiceStep = async (sock, sender, messageText, session) => {
  try {
    let nextSession = { ...session };
    const phoneNumber = sender.replace('@s.whatsapp.net', '');

    if (!phoneNumber) {
      throw new Error("Nomor telepon tidak ditemukan.");
    }

    switch (nextSession.invoiceState) {
      case 'AWAITING_NAME':
        nextSession.invoiceData.name = messageText;
        nextSession.invoiceData.phone = phoneNumber;
        nextSession.invoiceState = 'AWAITING_ADDRESS';
        await sock.sendMessage(sender, {
          text: "📍 MASUKKAN ALAMAT LENGKAP\nFormat: Desa, RT/RW, Kecamatan, Kabupaten\nContoh: Sambong, 02/03, Batang, Batang"
        });
        break;

      case 'AWAITING_ADDRESS': {
        const addressParts = messageText.split(',');
        if (addressParts.length !== 4) {
          await sock.sendMessage(sender, {
            text: "⚠️ Format alamat tidak valid! Contoh: Sambong, 02/03, Batang, Batang"
          });
          return;
        }
        const [village, rtRw, district, city] = addressParts.map(p => p.trim());
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
          const kota = nextSession.invoiceData.city; // Ambil kota dari data sebelumnya
          const shipping = await checkShippingCost(province, kota); // Tambahkan parameter kota

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
              nextSession.invoiceData.shipping.finalCost === '*GRATIS*' ? 0 :
                parseInt(nextSession.invoiceData.shipping.finalCost.replace(/\D/g, ''))
          });
        } catch (error) {
          await sock.sendMessage(sender, { text: `⚠️ ${error.message}` });
        }
        break;
      }

      case 'AWAITING_CONFIRMATION':
        switch (messageText) {
          case '1':
            await sock.sendMessage(sender, { text: "🔗 Mengarahkan ke menu pembayaran..." });
            userSessions.delete(sender); // Hapus sesi setelah memilih opsi
            return; // Hentikan fungsi setelah hapus sesi
            console.log(`Sesi dihapus untuk pengguna: ${sender}`); // Log untuk debugging
            
            return; // Hentikan fungsi setelah hapus sesi
          case '2':
            nextSession.invoiceState = 'AWAITING_EDIT_CHOICE';
            await sock.sendMessage(sender, {
              text: "🛒 Ingin mengubah yang mana?\n1. Ubah Nama\n2. Ubah Nomor Telepon\n3. Ubah Produk\n4. Ubah Alamat\n5. Batal"
            });
            break;
          case '3':
            try {
              const response = await saveInvoiceToSheet(nextSession.invoiceData);
              await sock.sendMessage(sender, { 
                text: `✅ Invoice disimpan. ID: ${response.idPesanan}` 
              });
              userSessions.delete(sender); // Hapus sesi setelah menyimpan invoice
              console.log(`Sesi dihapus untuk pengguna: ${sender}`); // Log untuk debugging
            } catch (error) {
              await sock.sendMessage(sender, { text: "⚠️ Gagal menyimpan: " + error.message });
              return; // Hentikan fungsi setelah hapus sesi
            }
            break;
          case '4':
            userSessions.delete(sender); // Hapus sesi setelah membatalkan invoice
            console.log(`Sesi dihapus untuk pengguna: ${sender}`); // Log untuk debugging
            await sock.sendMessage(sender, { text: "❌ Invoice dibatalkan" });
            break;
          default:
            await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid" });
            return; // Hentikan fungsi setelah hapus sesi
        }
        break;

      case 'AWAITING_EDIT_CHOICE':
        switch (messageText) {
          case '1':
            nextSession.invoiceState = 'AWAITING_NEW_NAME';
            await sock.sendMessage(sender, { text: "🛒 Masukkan nama baru:" });
            break;
          case '2':
            nextSession.invoiceState = 'AWAITING_NEW_PHONE';
            await sock.sendMessage(sender, { text: "📞 Masukkan nomor telepon baru:" });
            break;
          case '3':
            nextSession.invoiceState = 'AWAITING_NEW_PRODUCTS';
            await sock.sendMessage(sender, {
              text: "📋 Masukkan produk baru:\nFormat: [Nama Produk] [Jumlah]"
            });
            break;
          case '4':
            nextSession.invoiceState = 'AWAITING_NEW_ADDRESS';
            await sock.sendMessage(sender, {
              text: "📍 Masukkan alamat baru:\nContoh: Sambong, 02/03, Batang, Batang"
            });
            break;
            case '5':
              nextSession.invoiceState = 'AWAITING_CONFIRMATION';
              await showInvoiceConfirmation(sock, sender, nextSession.invoiceData);
              break;
            default:
              await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid" });
          }
          break;

      case 'AWAITING_NEW_NAME':
        nextSession.invoiceData.name = messageText;
        await kembaliKeMenuEdit(sock, sender, nextSession);
        break;

      case 'AWAITING_NEW_PHONE': {
        const newPhone = messageText.replace(/\D/g, '');
        if (newPhone.length < 10) {
          await sock.sendMessage(sender, { text: "⚠️ Nomor telepon tidak valid!" });
          return;
        }
        nextSession.invoiceData.phone = newPhone;
        await kembaliKeMenuEdit(sock, sender, nextSession);
        break;
      }

      case 'AWAITING_NEW_ADDRESS': {
        const addressParts = messageText.split(',');
        if (addressParts.length !== 4) {
          await sock.sendMessage(sender, { text: "⚠️ Format alamat salah!" });
          return;
        }
        const [village, rtRw, district, city] = addressParts.map(p => p.trim());
        nextSession.invoiceData.address = [
          `Desa: ${village}`, `RT/RW: ${rtRw}`, 
          `Kecamatan: ${district}`, `Kota: ${city}`
        ].join(', ');
        await kembaliKeMenuEdit(sock, sender, nextSession);
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
    }
userSessions.set(sender, nextSession);
    
  } catch (error) {
    console.error("Error:", error);
    await sock.sendMessage(sender, { text: `⚠️ Error: ${error.message}` });
    userSessions.set(sender, { ...session, invoiceState: null });
  }
};

module.exports = async (sock, message) => {
  const sender = message.key.remoteJid;
  const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text;

  if (!messageText) return;

  await handleAdminMessage(sock, message);
  if (!isBotActive()) return;

  let session = userSessions.get(sender) || { 
    invoiceState: null, 
    invoiceData: {}, 
    previousInvoice: null 
  };

  if (session.invoiceState === 'AWAITING_INVOICE_ACTION') {
    await handleInvoiceAction(sock, sender, messageText, session);
    return;
  }

  if (session.invoiceState) {
    await handleInvoiceStep(sock, sender, messageText, session);
    return;
  }

  if (/^\. ?invoice$/i.test(messageText)) {
    if (session.previousInvoice) {
      await tampilkanInvoiceSebelumnya(sock, sender, session);
    } else {
      userSessions.set(sender, { 
        invoiceState: 'AWAITING_NAME', 
        invoiceData: {} 
      });
      await sock.sendMessage(sender, { 
        text: "🛒 MEMULAI PEMESANAN\nSilakan masukkan nama Anda:" 
      });
    }
    return;
  }

  const lowerMessage = messageText.toLowerCase();
  if (salamKeywords.some(kw => lowerMessage.includes(kw))) {
    await sock.sendMessage(sender, { 
      text: "Waalaikumsalam! Ketik .menu untuk melihat opsi."
    });
    return;
  }

  if (!userSessions.has(sender)) {
    userSessions.set(sender, { inProductList: false, invoiceState: null });
    await sock.sendMessage(sender, { 
      text: "Halo! Ketik .menu untuk melihat opsi."
    });
    return;
  }

  if (sapaanKeywords.some(kw => lowerMessage.includes(kw))) {
    await sock.sendMessage(sender, { 
      text: "Ada yang bisa kami bantu? Ketik .menu untuk opsi."
    });
    return;
  }

  if (/^\. ?menu$/i.test(messageText)) {
    await sock.sendMessage(sender, {
      text: "📌 Menu:\n.produk - Lihat produk\n.invoice - Buat pesanan\n.alamat - Info toko"
    });
    return;
  }

  if (/^\. ?produk$/i.test(messageText)) {
    await sendProductList(sock, sender);
    userSessions.set(sender, { ...session, inProductList: true });
    return;
  }

  if (session.inProductList) {
    await sendProductDetail(sock, sender, messageText);
    userSessions.set(sender, { ...session, inProductList: false });
    return;
  }

  // Jika pesan tidak dikenali, kirim pesan default
  await sock.sendMessage(sender, { 
    text: "Halo! Ketik .menu untuk melihat opsi."
  });
};
