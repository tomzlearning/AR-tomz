const { sendProductList, sendProductDetail, getProducts } = require('./productHandler');
const { handleAdminMessage, isBotActive } = require('./adminHandler');
const { saveInvoiceToSheet, waitForUserResponse, checkShippingCost, parseProductsInput, showInvoiceConfirmation, getInvoicesByPhone, getInvoiceById, updateInvoiceStatus, generateInvoicePDF } = require('./invoiceHandler');

const userSessions = new Map();
const salamKeywords = ["assalamualaikum", "asalamualaikum", "assalamu'alaikum", "aslm"];
const sapaanKeywords = ["halo", "hai", "pagi", "siang", "sore", "malam", "hallo", "hei", "hey", "bos", "bro", "gan"];

const kembaliKeMenuEdit = async (sock, sender, session) => {
  session.invoiceState = 'AWAITING_EDIT_CHOICE';
  await sock.sendMessage(sender, {
    text: "🛒 Ingin mengubah yang mana?\n1. Ubah Nama\n2. Ubah Nomor Telepon\n3. Ubah Produk\n4. Ubah Alamat\n5. Kembali"
  });
  userSessions.set(sender, session); // Simpan session
};

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
  userSessions.set(sender, session); // Simpan session
};

const showDraftInvoices = async (sock, sender, invoices) => {
  if (invoices.length === 0) {
    await sock.sendMessage(sender, { text: "📭 Tidak ada invoice tersimpan." });
    return;
  }

  let invoiceList = "📝 Invoice yang tersimpan:\n";
  invoices.forEach((invoice, index) => {
    invoiceList += `${index + 1}. ID: ${invoice.id} (Status: ${invoice.status})\n`;
  });

  invoiceList += "\nPilihan:\n1. Kelola Invoice\n2. Buat invoice baru";
  await sock.sendMessage(sender, { text: invoiceList });

  // Set session state ke AWAITING_INVOICE_ACTION
  const session = userSessions.get(sender) || {
    invoiceState: null,
    invoiceData: {},
    previousInvoice: null
  };
  session.invoiceState = 'AWAITING_INVOICE_ACTION'; // Set state untuk menunggu pilihan
  userSessions.set(sender, session); // Simpan session
};

const handleInvoiceAction = async (sock, sender, messageText, session) => {
  console.log("Memproses opsi:", messageText); // Debugging

  // Ambil nomor telepon dari sender
  const phoneNumber = sender.replace('@s.whatsapp.net', '');

  if (!phoneNumber) {
    await sock.sendMessage(sender, { text: "❌ Nomor telepon tidak valid." });
    return;
  }
  

  switch (messageText) {
    case '1': // Kelola Invoice
      console.log("Opsi 1 dipilih. Session:", session); // Debugging
      const invoices = await getInvoicesByPhone(phoneNumber);
      if (invoices.length === 0) {
        await sock.sendMessage(sender, { text: "📭 Tidak ada invoice tersimpan." });
        return;
      }

      let invoiceList = "📝 Invoice yang tersimpan:\n";
      invoices.forEach((invoice, index) => {
        invoiceList += `${index + 1}. ID: ${invoice.id} (Status: ${invoice.status})\n`;
      });

      invoiceList += "\nKetik nomor invoice yang ingin Anda kelola.\nContoh: 1";
      await sock.sendMessage(sender, { text: invoiceList });

      session.invoiceState = 'AWAITING_INVOICE_SELECTION'; // Ubah state untuk menunggu pilihan invoice
      userSessions.set(sender, session); // Simpan session
      break;

    case '2': // Buat Invoice Baru
      console.log("Opsi 2 dipilih. Session:", session); // Debugging
      // Reset session untuk memulai invoice baru
      userSessions.set(sender, {
        invoiceState: 'AWAITING_NAME', // Mulai dari langkah memasukkan nama
        invoiceData: {}, // Reset data invoice
        previousInvoice: null // Hapus invoice sebelumnya
      });
      await sock.sendMessage(sender, { 
        text: "🛒 MEMULAI PEMESANAN BARU\nSilakan masukkan nama Anda:" 
      });
      break;

    default:
      console.log("Opsi tidak valid:", messageText); // Debugging
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

    console.log("Memproses pesan dengan state:", nextSession.invoiceState); // Debugging

    switch (nextSession.invoiceState) {
      case 'AWAITING_NAME':
        console.log("Menerima nama:", messageText); // Debugging
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
            text: "⚠️ Format alamat tidak valid! Pastikan format:\nDesa, RT/RW, Kecamatan, Kabupaten\nContoh: Sambong, 02/03, Batang, Batang"
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

      case 'AWAITING_CONFIRMATION':
        switch (messageText) {
          case '1': // Lanjut Pembayaran
            try {
              await updateInvoiceStatus(session.previousInvoice.id, "Dikirim");
              await sock.sendMessage(sender, { text: "✅ Pembayaran berhasil. Status invoice telah diupdate." });
            } catch (error) {
              await sock.sendMessage(sender, { text: `⚠️ Gagal memproses pembayaran: ${error.message}` });
            }
            userSessions.delete(sender);
            return;

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
            await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid" });
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
        const addressParts = messageText.split(',')
          .map(part => part.trim())
          .filter(part => part !== '');

        if (addressParts.length !== 4) {
          await sock.sendMessage(sender, { text: "⚠️ Format alamat salah!" });
          return;
        }

        const [village, rtRw, district, city] = addressParts;
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

      
        // File: messageHandler.js (dalam fungsi handleInvoiceStep)

        case 'AWAITING_INVOICE_SELECTION': {
          const invoices = await getInvoicesByPhone(phoneNumber);
          
          // Validasi input
          const selectedIndex = parseInt(messageText) - 1;
          
          if (isNaN(selectedIndex)) {
            await sock.sendMessage(sender, { text: "❌ Harap masukkan nomor yang valid." });
            return;
          }
  
          if (selectedIndex < 0 || selectedIndex >= invoices.length) {
            await sock.sendMessage(sender, { text: "❌ Nomor invoice tidak valid." });
            return;
          }
  
          const selectedInvoice = invoices[selectedIndex];
          
          // Update session
          nextSession.previousInvoice = selectedInvoice;
          console.log("Invoice dipilih:", selectedInvoice); // Debugging
  
          // Proses berdasarkan status
          if (selectedInvoice.status.toUpperCase() === 'DRAFT') {
            // ... (kode DRAFT tetap sama)
          } 
          else if (selectedInvoice.status.toUpperCase() === 'PROSES PENGIRIMAN') {
            const productList = selectedInvoice.items.map(item =>
              `${item.name} (${item.qty}x Rp${item.price.toLocaleString('id-ID')}) = Rp${item.subtotal.toLocaleString('id-ID')}`
            ).join('\n') || "Belum ada produk.";
  
            await sock.sendMessage(sender, {
              text: `📝 DETAIL INVOICE (Proses Pengiriman)\n➖➖➖➖➖➖➖➖➖➖\nID: ${selectedInvoice.id}\nNama: ${selectedInvoice.name}\nNo. Telepon: ${selectedInvoice.phone}\nAlamat: ${selectedInvoice.address}\n\nProduk:\n${productList}\n\nOngkir: ${selectedInvoice.shipping.originalCost} ${selectedInvoice.shipping.finalCost}\nEstimasi: ${selectedInvoice.shipping.estimate}\nNomor Resi: ${selectedInvoice.shipping.resi || "Belum diisi"}\n➖➖➖➖➖➖➖➖➖➖\nTOTAL: Rp${selectedInvoice.total.toLocaleString('id-ID')}\n\nPilihan:\n1. Cetak Invoice\n2. Kembali`
            });
            nextSession.invoiceState = 'AWAITING_SHIPPING_ACTION'; // ◀◀◀ UPDATE STATE
          }
  
          userSessions.set(sender, nextSession);
          break;
        }
  
        case 'AWAITING_SHIPPING_ACTION': {
          console.log("[DEBUG] Masuk state shipping action"); // Debugging
          switch (messageText) {
            case '1': // Cetak Invoice
              try {
                console.log("[DEBUG] Membuat PDF untuk:", nextSession.previousInvoice);
                const pdfBuffer = await generateInvoicePDF(nextSession.previousInvoice);
                
                if (!pdfBuffer || pdfBuffer.length === 0) {
                  throw new Error("Buffer PDF kosong");
                }
  
                await sock.sendMessage(sender, {
                  document: pdfBuffer,
                  mimetype: 'application/pdf',
                  fileName: `Invoice_${nextSession.previousInvoice.id}.pdf`
                });
                await sock.sendMessage(sender, { text: "✅ Invoice PDF berhasil dikirim." });
  
              } catch (error) {
                console.error("Gagal membuat PDF:", error);
                await sock.sendMessage(sender, { 
                  text: "⚠️ Gagal membuat invoice. Silakan coba lagi atau hubungi admin." 
                });
              }
              break;
  
            case '2': // Kembali
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

       // Perbaikan opsi 'Kembali'
        case '4': // Kembali
        session.invoiceState = 'AWAITING_INVOICE_ACTION';
        await handleInvoiceAction(sock, sender, '1', session); // Kembali ke menu Kelola Invoice
        return;

        default:
          await sock.sendMessage(sender, { text: "❌ Pilihan tidak valid" });
      }
      break;

    } 

    

    // Simpan progres sesi
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
};
