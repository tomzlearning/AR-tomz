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
  const lines = input.split('\n'); // Pisahkan input menjadi beberapa baris

  const itemsMap = new Map(); // Gunakan Map untuk menggabungkan produk dengan nama yang sama

  for (const line of lines) {
    const trimmedLine = line.trim(); // Hilangkan spasi di awal dan akhir baris
    if (!trimmedLine) continue; // Lewati baris kosong

    // Pisahkan nama produk dan jumlah
    const lastSpaceIndex = trimmedLine.lastIndexOf(' '); // Cari spasi terakhir
    if (lastSpaceIndex === -1) {
      throw new Error(`Format input produk tidak valid: "${trimmedLine}". Harus dalam format: [Nama Produk] [Jumlah]`);
    }

    const name = trimmedLine.substring(0, lastSpaceIndex).trim(); // Ambil nama produk
    const qty = trimmedLine.substring(lastSpaceIndex + 1).trim(); // Ambil jumlah

    // Validasi jumlah (harus angka)
    if (isNaN(qty)) {
      throw new Error(`Jumlah produk tidak valid: "${qty}". Harus berupa angka.`);
    }

    // Cari produk berdasarkan nama
    const product = products.find(p => 
      p['Nama Produk'].toLowerCase() === name.toLowerCase()
    );

    if (!product) throw new Error(`Produk "${name}" tidak ditemukan`);
    if (product.Stok.toLowerCase() !== 'ready') throw new Error(`Stok "${name}" habis`);

    // Jika produk sudah ada di Map, tambahkan jumlahnya
    if (itemsMap.has(name)) {
      const existingItem = itemsMap.get(name);
      existingItem.qty += parseInt(qty);
      existingItem.subtotal = existingItem.price * existingItem.qty;
    } else {
      // Jika produk belum ada di Map, tambahkan sebagai item baru
      itemsMap.set(name, {
        name: product['Nama Produk'],
        price: product.Harga,
        qty: parseInt(qty),
        subtotal: product.Harga * parseInt(qty)
      });
    }
  }

  // Konversi Map ke array
  const items = Array.from(itemsMap.values());

  // Hitung total harga
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
    const response = await axios.post(process.env.APP_SCRIPT_URL, {
      action: 'save',
      data: invoiceData
    });
    return response.data;
  } catch (error) {
    throw new Error('Gagal menyimpan invoice ke spreadsheet: ' + error.message);
  }
};

module.exports = { 
  waitForUserResponse,
  checkShippingCost,
  parseProductsInput,
  showInvoiceConfirmation,
  saveInvoiceToSheet
};