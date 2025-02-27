const axios = require('axios');
const { getProducts } = require('./productHandler');

// Fungsi untuk menunggu respons pengguna
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

// Fungsi untuk memeriksa biaya pengiriman
const checkShippingCost = async (province) => {
  try {
    const response = await axios.get(`${process.env.APP_SCRIPT_URL}?action=get&sheet=ongkir`);
    const shippingData = response.data;

    const area = shippingData.find(item => 
      item.Provinsi.toLowerCase() === province.toLowerCase()
    );

    if (!area) throw new Error('Provinsi tidak terdaftar');

    const ongkir = String(area.Ongkir || '0').replace(/\D/g, '');
    let finalCost = parseInt(ongkir);
    let discount = 0;

    if (area.Pulau === 'Jawa') {
      discount = finalCost;
      finalCost = 0;
    } else {
      discount = 20000;
      finalCost = Math.max(finalCost - discount, 0);
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

    // Cari produk berdasarkan nama (termasuk ID Produk)
    const product = products.find(p => 
      p["Nama Produk"].toLowerCase() === name.toLowerCase()
    );

    if (!product) throw new Error(`Produk "${name}" tidak ditemukan`);
    if (product.Stok.toLowerCase() !== 'ready') throw new Error(`Stok "${name}" habis`);

    // Simpan ID Produk
    if (itemsMap.has(name)) {
      const existingItem = itemsMap.get(name);
      existingItem.qty += parseInt(qty);
      existingItem.subtotal = existingItem.price * existingItem.qty;
    } else {
      itemsMap.set(name, {
        id: product["ID Produk"], // Ambil ID Produk dari DATA_PRODUK
        name: product["Nama Produk"],
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

  // Berikan nilai default jika field tidak terisi
  const safePhone = phone || "Belum diisi";
  const safeAddress = address || "Belum diisi";
  const safeProducts = products || { items: [], total: 0 };
  const safeShipping = shipping || { originalCost: "Belum diisi", finalCost: "Belum diisi", estimate: "Belum diisi" };
  const safeTotal = total || 0;

  // Format daftar produk dengan harga satuan
  const productList = safeProducts.items.map(item =>
    `${item.name} (${item.qty}x Rp${item.price.toLocaleString('id-ID')}) = Rp${item.subtotal.toLocaleString('id-ID')}`
  ).join('\n') || "Belum ada produk.";

  // Format ringkasan pesanan
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
// Fungsi untuk menyimpan invoice ke spreadsheet
const saveInvoiceToSheet = async (invoiceData) => {
  try {
    // 1️⃣ Simpan ke DATA_PEMESAN
    await axios.post(process.env.APP_SCRIPT_URL, {
      action: 'save',
      sheet: 'DATA_PEMESAN',
      data: {
        "Nomor WA": invoiceData.phone,
        "Nama Pemesan": invoiceData.name,
        "Alamat Lengkap": invoiceData.address,
        "Tanggal Bergabung": new Date().toISOString().split('T')[0]
      }
    });

    // 2️⃣ Simpan ke DATA_PESANAN
    const totalCost = invoiceData.products.total + 
      (invoiceData.shipping.finalCost === '*GRATIS*' ? 0 : 
        parseInt(invoiceData.shipping.finalCost.replace(/\D/g, '')));

    const responsePesanan = await axios.post(process.env.APP_SCRIPT_URL, {
      action: 'save',
      sheet: 'DATA_PESANAN',
      data: {
        "Nomor WA": invoiceData.phone,
        "Tanggal Pemesanan": new Date().toISOString().split('T')[0],
        "Metode Pembayaran": "Belum diisi",
        "Status Pembayaran": "DRAFT",
        "Status Pengiriman": "Dalam Proses",
        "No. Resi": "",
        "Estimasi Pengiriman": invoiceData.shipping.estimate,
        "Total Harga": totalCost,
        "Alamat Pengiriman": invoiceData.address,
        "Provinsi": invoiceData.shipping.province,
        "Ongkir": invoiceData.shipping.finalCost
      }
    });

    const idPesanan = responsePesanan.data.idPesanan; // Ambil ID Pesanan dari response

    // 3️⃣ Simpan ke DETAIL_PRODUK_PESANAN
    for (const item of invoiceData.products.items) {
      await axios.post(process.env.APP_SCRIPT_URL, {
        action: 'save',
        sheet: 'DETAIL_PRODUK_PESANAN',
        data: {
          "ID Pesanan": idPesanan, // Pastikan ini sama dengan ID Pesanan di DATA_PESANAN
          "ID Produk": item.id,
          "Nama Produk": item.name,
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
