const axios = require('axios');
const { getProducts } = require('./productHandler');

// Fungsi untuk menunggu respons user
const waitForUserResponse = async (sock, sender) => {
  return new Promise((resolve) => {
    const listener = (m) => {
      const message = m.messages[0];
      if (message?.key?.remoteJid === sender && !message?.key?.fromMe) {
        sock.ev.off('messages.upsert', listener);
        resolve(message.message?.conversation || message.message?.extendedTextMessage?.text || '');
      }
    };

    const timeout = setTimeout(() => {
      sock.ev.off('messages.upsert', listener);
      resolve('');
    }, 30000);

    sock.ev.on('messages.upsert', listener);
  });
};

// Fungsi untuk mengecek ongkir
const checkShippingCost = async (province) => {
  try {
    const response = await axios.get(`${process.env.APP_SCRIPT_URL}?action=get&sheet=DATA_ONGKIR`);
    const shippingData = response.data;

    const area = shippingData.find(item => 
      item.Provinsi.toLowerCase() === province.toLowerCase()
    );

    if (!area) {
      throw new Error('Provinsi tidak terdaftar');
    }

    const ongkir = String(area.Ongkir || '0').replace(/\D/g, '');
    let finalCost = parseInt(ongkir);
    let discount = 0;

    if (area.Pulau === 'Jawa') {
      discount = finalCost; // Potongan sebesar ongkir (GRATIS)
      finalCost = 0;
    } else {
      discount = 20000; // Potongan Rp20.000 untuk luar Jawa
      finalCost = Math.max(finalCost - discount, 0); // Pastikan ongkir tidak negatif
    }

    return {
      province: area.Provinsi,
      island: area.Pulau,
      originalCost: `~Rp${parseInt(ongkir).toLocaleString('id-ID')}~`,
      finalCost: finalCost === 0 ? '*GRATIS*' : `Rp${finalCost.toLocaleString('id-ID')}`,
      discount: `Rp${discount.toLocaleString('id-ID')}`,
      estimate: area.Estimasi
    };
  } catch (error) {
    throw new Error(`Gagal cek ongkir: ${error.message}`);
  }
};

// Fungsi untuk memproses input produk
const parseProductsInput = async (input) => {
  const products = await getProducts();
  const lines = input.split('\n');

  const itemsMap = new Map();

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const lastSpaceIndex = trimmedLine.lastIndexOf(' ');
    const name = trimmedLine.substring(0, lastSpaceIndex).trim();
    const qty = trimmedLine.substring(lastSpaceIndex + 1).trim();

    const product = products.find(p => 
      p.Nama_Produk.toLowerCase() === name.toLowerCase()
    );

    if (!product) throw new Error(`Produk "${name}" tidak ditemukan`);
    if (product.Stok.toLowerCase() !== 'ready') throw new Error(`Stok "${name}" habis`);

    if (itemsMap.has(name)) {
      const existingItem = itemsMap.get(name);
      existingItem.qty += parseInt(qty);
      existingItem.subtotal = existingItem.price * existingItem.qty;
    } else {
      itemsMap.set(name, {
        id: product.ID_Produk,
        name: product.Nama_Produk,
        price: product.Harga,
        qty: parseInt(qty),
        subtotal: product.Harga * parseInt(qty)
      });
    }
  }

  const items = Array.from(itemsMap.values());
  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  return { items, total };
};

// Fungsi untuk menampilkan konfirmasi invoice
const showInvoiceConfirmation = async (sock, sender, invoiceData) => {
  const { name, phone, address, products, shipping, total } = invoiceData;

  const safePhone = phone || "Belum diisi";
  const safeAddress = address || "Belum diisi";
  const safeProducts = products || { items: [], total: 0 };
  const safeShipping = shipping || { originalCost: "Belum diisi", finalCost: "Belum diisi", estimate: "Belum diisi" };

  // Perbaikan: Hitung total dengan benar, termasuk ongkir
  const shippingCost = safeShipping.finalCost === '*GRATIS*' ? 0 : parseInt(safeShipping.finalCost.replace(/\D/g, ''));
  const safeTotal = safeProducts.total + shippingCost;

  const productList = safeProducts.items.map(item =>
    `${item.name} (${item.qty}x Rp${item.price.toLocaleString('id-ID')}) = Rp${item.subtotal.toLocaleString('id-ID')}`
  ).join('\n') || "Belum ada produk.";

  const summary = `📝 RINGKASAN PESANAN
➖➖➖➖➖➖➖➖➖➖
Nama: ${name || "Belum diisi"}
No. Telepon: ${safePhone}
Alamat: ${safeAddress}

Produk:
${productList}

Ongkir: ${safeShipping.originalCost} ${safeShipping.finalCost}
Estimasi: ${safeShipping.estimate}
➖➖➖➖➖➖➖➖➖➖
TOTAL: Rp${safeTotal.toLocaleString('id-ID')}

Pilihan:
1. Lanjut Pembayaran
2. Ubah
3. Simpan
4. Batal`;

  await sock.sendMessage(sender, { text: summary });
};

// Fungsi untuk menyimpan invoice ke sheet
const saveInvoiceToSheet = async (invoiceData) => {
  try {
    // Simpan ke DATA_PEMESAN
    await axios.post(process.env.APP_SCRIPT_URL, {
      action: 'save',
      sheet: 'DATA_PEMESAN',
      data: {
        "Nomor WA": invoiceData.phone,
        "Nama Pemesan": invoiceData.name, // Pastikan ini sesuai dengan ringkasan pesanan
        "Alamat_Utama": invoiceData.address,
        "Tanggal Bergabung": new Date().toISOString().split('T')[0]
      }
    });

    // Simpan ke DATA_PESANAN
    const totalCost = invoiceData.products.total + 
      (invoiceData.shipping.finalCost === '*GRATIS*' ? 0 : 
        parseInt(invoiceData.shipping.finalCost.replace(/\D/g, '')));

    const responsePesanan = await axios.post(process.env.APP_SCRIPT_URL, {
      action: 'save',
      sheet: 'DATA_PESANAN',
      data: {
        "Nomor WA": invoiceData.phone,
        "Nama Pemesan": invoiceData.name, // Pastikan ini sesuai dengan ringkasan pesanan
        "Nomor Telepon": invoiceData.phone,
        "Alamat_Pengiriman": invoiceData.address,
        "Provinsi": invoiceData.shipping.province, // Pastikan ini sesuai dengan ringkasan pesanan
        "Tanggal Pemesanan": new Date().toISOString().split('T')[0],
        "Metode Pembayaran": "Belum diisi",
        "Status Pembayaran": "DRAFT",
        "Status Pengiriman": "Dalam Proses",
        "No_Resi": "",
        "Estimasi_Pengiriman": invoiceData.shipping.estimate,
        "Ongkir": invoiceData.shipping.finalCost === '*GRATIS*' ? 0 : parseInt(invoiceData.shipping.finalCost.replace(/\D/g, '')), // Pastikan ini sesuai dengan ringkasan pesanan
        "Total_Harga": totalCost, // Pastikan ini sesuai dengan ringkasan pesanan
        "Catatan": "",
        "Tanggal_Diubah": new Date().toISOString()
      }
    });

    const idPesanan = responsePesanan.data.idPesanan;

    // Simpan ke DETAIL_PRODUK_PESANAN
    for (const item of invoiceData.products.items) {
      await axios.post(process.env.APP_SCRIPT_URL, {
        action: 'save',
        sheet: 'DETAIL_PRODUK_PESANAN',
        data: {
          "ID_Pesanan": idPesanan,
          "ID_Produk": item.id,
          "Nama_Produk": item.name,
          "Harga_Saat_Itu": item.price,
          "Jumlah": item.qty,
          "Subtotal": item.subtotal
        }
      });
    }

    return { success: true, message: "Invoice berhasil disimpan.", idPesanan: idPesanan };
  } catch (error) {
    throw new Error('Gagal menyimpan invoice: ' + error.message);
  }
};
module.exports = { 
  waitForUserResponse,
  checkShippingCost,
  parseProductsInput,
  showInvoiceConfirmation,
  saveInvoiceToSheet
};
