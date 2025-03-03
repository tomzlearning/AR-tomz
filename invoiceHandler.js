const axios = require("axios");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const { getProducts } = require("./productHandler");

// Fungsi untuk menunggu respons user
const waitForUserResponse = async (sock, sender) => {
  return new Promise((resolve) => {
    const listener = (m) => {
      const message = m.messages[0];
      if (message?.key?.remoteJid === sender && !message?.key?.fromMe) {
        sock.ev.off("messages.upsert", listener);
        resolve(
          message.message?.conversation ||
            message.message?.extendedTextMessage?.text ||
            ""
        );
      }
    };

    const timeout = setTimeout(() => {
      sock.ev.off("messages.upsert", listener);
      resolve("");
    }, 30000);

    sock.ev.on("messages.upsert", listener);
  });
};

// Fungsi untuk mengecek ongkir
const checkShippingCost = async (province) => {
  try {
    const response = await axios.get(
      `${process.env.APP_SCRIPT_URL}?action=get&sheet=DATA_ONGKIR`
    );
    const shippingData = response.data;

    const area = shippingData.find(
      (item) => item.Provinsi.toLowerCase() === province.toLowerCase()
    );

    if (!area) {
      throw new Error("Provinsi tidak terdaftar");
    }

    const ongkir = String(area.Ongkir || "0").replace(/\D/g, "");
    let finalCost = parseInt(ongkir);
    let discount = 0;

    if (area.Pulau === "Jawa") {
      discount = finalCost; // Potongan sebesar ongkir (GRATIS)
      finalCost = 0;
    } else {
      discount = 20000; // Potongan Rp20.000 untuk luar Jawa
      finalCost = Math.max(finalCost - discount, 0); // Pastikan ongkir tidak negatif
    }

    return {
      province: area.Provinsi,
      island: area.Pulau,
      originalCost: `~Rp${parseInt(ongkir).toLocaleString("id-ID")}~`,
      finalCost:
        finalCost === 0 ? "*GRATIS*" : `Rp${finalCost.toLocaleString("id-ID")}`,
      discount: `Rp${discount.toLocaleString("id-ID")}`,
      estimate: area.Estimasi,
    };
  } catch (error) {
    throw new Error(`Gagal cek ongkir: ${error.message}`);
  }
};

// Fungsi untuk memproses input produk
const parseProductsInput = async (input) => {
  const products = await getProducts();
  const lines = input.split("\n");

  const itemsMap = new Map();

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const lastSpaceIndex = trimmedLine.lastIndexOf(" ");
    const name = trimmedLine.substring(0, lastSpaceIndex).trim();
    const qty = trimmedLine.substring(lastSpaceIndex + 1).trim();

    const product = products.find(
      (p) => p.Nama_Produk.toLowerCase() === name.toLowerCase()
    );

    if (!product) throw new Error(`Produk "${name}" tidak ditemukan`);
    if (product.Stok.toLowerCase() !== "ready")
      throw new Error(`Stok "${name}" habis`);

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
        subtotal: product.Harga * parseInt(qty),
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
  const safeShipping = shipping || {
    originalCost: "Belum diisi",
    finalCost: "Belum diisi",
    estimate: "Belum diisi",
  };

  const shippingCost =
    safeShipping.finalCost === "*GRATIS*"
      ? 0
      : parseInt(safeShipping.finalCost.replace(/\D/g, ""));
  const safeTotal = safeProducts.total + shippingCost;

  const productList =
    safeProducts.items
      .map(
        (item) =>
          `${item.name} (${item.qty}x Rp${item.price.toLocaleString(
            "id-ID"
          )}) = Rp${item.subtotal.toLocaleString("id-ID")}`
      )
      .join("\n") || "Belum ada produk.";

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
TOTAL: Rp${safeTotal.toLocaleString("id-ID")}

Pilihan:
1. Lanjut Pembayaran
2. Ubah
3. Simpan
4. Hapus`;

  await sock.sendMessage(sender, { text: summary });
};

// Fungsi untuk menyimpan invoice ke sheet
const saveInvoiceToSheet = async (invoiceData) => {
  try {
    await axios.post(process.env.APP_SCRIPT_URL, {
      action: "save",
      sheet: "DATA_PEMESAN",
      data: {
        "Nomor WA": invoiceData.phone,
        "Nama Pemesan": invoiceData.name,
        Alamat_Utama: invoiceData.address,
        "Tanggal Bergabung": new Date().toISOString().split("T")[0],
      },
    });

    const totalCost =
      invoiceData.products.total +
      (invoiceData.shipping.finalCost === "*GRATIS*"
        ? 0
        : parseInt(invoiceData.shipping.finalCost.replace(/\D/g, "")));

    const responsePesanan = await axios.post(process.env.APP_SCRIPT_URL, {
      action: "save",
      sheet: "DATA_PESANAN",
      data: {
        "Nomor WA": invoiceData.phone,
        "Nama Pemesan": invoiceData.name,
        "Nomor Telepon": invoiceData.phone,
        Alamat_Pengiriman: invoiceData.address,
        Provinsi: invoiceData.shipping.province,
        "Tanggal Pemesanan": new Date().toISOString().split("T")[0],
        "Metode Pembayaran": "Belum diisi",
        "Status Pembayaran": "DRAFT",
        "Status Pengiriman": "Dalam Proses",
        No_Resi: "",
        Estimasi_Pengiriman: invoiceData.shipping.estimate,
        Ongkir:
          invoiceData.shipping.finalCost === "*GRATIS*"
            ? 0
            : parseInt(invoiceData.shipping.finalCost.replace(/\D/g, "")),
        Total_Harga: totalCost,
        Catatan: "",
        Tanggal_Diubah: new Date().toISOString(),
      },
    });

    const idPesanan = responsePesanan.data.idPesanan;

    for (const item of invoiceData.products.items) {
      await axios.post(process.env.APP_SCRIPT_URL, {
        action: "save",
        sheet: "DETAIL_PRODUK_PESANAN",
        data: {
          ID_Pesanan: idPesanan,
          ID_Produk: item.id,
          Nama_Produk: item.name,
          Harga_Saat_Itu: item.price,
          Jumlah: item.qty,
          Subtotal: item.subtotal,
        },
      });
    }

    return {
      success: true,
      message: "Invoice berhasil disimpan.",
      idPesanan: idPesanan,
    };
  } catch (error) {
    throw new Error("Gagal menyimpan invoice: " + error.message);
  }
};

// Fungsi untuk mengambil invoice berdasarkan nomor telepon
// Fungsi untuk mengambil invoice berdasarkan nomor telepon
const getInvoicesByPhone = async (phone) => {
  try {
    // Ambil data invoice dari sheet DATA_PESANAN
    const responsePesanan = await axios.get(
      `${process.env.APP_SCRIPT_URL}?action=get&sheet=DATA_PESANAN&phone=${phone}`
    );
    const invoices = responsePesanan.data;

    // Ambil semua data produk dari sheet DETAIL_PRODUK_PESANAN
    const responseProduk = await axios.get(
      `${process.env.APP_SCRIPT_URL}?action=get&sheet=DETAIL_PRODUK_PESANAN`
    );
    const allProduk = responseProduk.data;

    // Gabungkan data produk ke dalam invoice
    for (const invoice of invoices) {
      invoice.items = allProduk
        .filter((produk) => produk.ID_Pesanan === invoice.ID_Pesanan)
        .map((produk) => ({
          id: produk.ID_Produk,
          name: produk.Nama_Produk,
          price: Number(produk.Harga_Saat_Itu), // Pastikan berupa angka
          qty: Number(produk.Jumlah), // Pastikan berupa angka
          subtotal: Number(produk.Subtotal), // Pastikan berupa angka
        }));
    }

    // Format data invoice
    return invoices.map((invoice) => ({
      id: invoice.ID_Pesanan,
      status: invoice.Status_Pembayaran,
      name: invoice.Nama_Pemesan,
      phone: invoice.Nomor_Telepon,
      address: invoice.Alamat_Pengiriman,
      items: invoice.items || [],
      shipping: {
        province: invoice.Provinsi,
        originalCost: invoice.Ongkir
          ? `~Rp${invoice.Ongkir.toLocaleString("id-ID")}~`
          : "Belum diisi",
        finalCost:
          invoice.Ongkir === 0
            ? "*GRATIS*"
            : `Rp${invoice.Ongkir.toLocaleString("id-ID")}`,
        estimate: invoice.Estimasi_Pengiriman || "Belum diisi",
        resi: invoice.No_Resi || "", // Pastikan field resi ada
      },
      total: Number(invoice.Total_Harga) || 0, // Pastikan berupa angka
    }));
  } catch (error) {
    console.error("Gagal mengambil invoice:", {
      error: error.message,
      stack: error.stack,
    });
    return [];
  }
};
// Fungsi untuk mengambil invoice berdasarkan ID
const getInvoiceById = async (invoiceId) => {
  try {
    const response = await axios.get(
      `${process.env.APP_SCRIPT_URL}?action=get&sheet=DATA_PESANAN&id=${invoiceId}`
    );
    return response.data;
  } catch (error) {
    console.error("Gagal mengambil data invoice:", error.message);
    return null;
  }
};

// Fungsi untuk mengupdate status invoice berdasarkan ID
const updateInvoiceStatus = async (invoiceId, newStatus) => {
  try {
    const response = await axios.post(process.env.APP_SCRIPT_URL, {
      action: "update",
      sheet: "DATA_PESANAN",
      id: invoiceId,
      data: {
        Status_Pengiriman: newStatus,
      },
    });
    return { success: true, message: "Status invoice berhasil diupdate." };
  } catch (error) {
    throw new Error("Gagal mengupdate status invoice: " + error.message);
  }
};

// Fungsi untuk menghasilkan PDF dari data invoice
const generateInvoicePDF = async (invoice) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 40,
      size: "A4",
      font: "Helvetica",
    });

    const buffers = [];
    const primaryColor = "#1a73e8"; // Warna biru utama
    const secondaryColor = "#5f6368"; // Warna abu-abu sekunder
    let y = 40; // Posisi vertikal awal

    doc.on("data", buffers.push.bind(buffers));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    // Header
    doc
      .fillColor(primaryColor)
      .fontSize(20)
      .font("Helvetica-Bold")
      .text("SI CANTIK HERBAL", 50, y, { align: "left" });

    doc
      .fillColor(secondaryColor)
      .fontSize(10)
      .text("Jl. Kesehatan No. 123, Jakarta", 50, y + 25)
      .text(
        "Telp: (021) 555-1234 | Email: sicantikherbal@example.com",
        50,
        y + 40
      );

    y += 70;

    // Garis pembatas header
    doc
      .moveTo(50, y)
      .lineTo(550, y)
      .lineWidth(1)
      .strokeColor(primaryColor)
      .stroke();

    y += 20;

    // Informasi Invoice
    doc
      .fillColor(primaryColor)
      .fontSize(16)
      .text("# INVOICE PEMBELIAN", 50, y, { align: "left" });

    y += 30;

    // Detail Pelanggan
    doc
      .fillColor(secondaryColor)
      .fontSize(10)
      .text("Nama Pelanggan:", 50, y, { align: "left" })
      .fillColor("#202124")
      .text(invoice.name, 180, y, { align: "left" });

    y += 20;

    doc
      .fillColor(secondaryColor)
      .text("Nomor Telepon:", 50, y, { align: "left" })
      .fillColor("#202124")
      .text(invoice.phone, 180, y, { align: "left" });

    y += 20;

    doc
      .fillColor(secondaryColor)
      .text("Alamat:", 50, y, { align: "left" })
      .fillColor("#202124")
      .text(invoice.address, 180, y, { align: "left" });

    y += 20;

    doc
      .fillColor(secondaryColor)
      .text("Estimasi:", 50, y, { align: "left" })
      .fillColor("#202124")
      .text(invoice.shipping.estimate, 180, y, { align: "left" });

    y += 40;

    // Informasi Pembayaran (Tabel Tanpa Warna dan Garis)
    const paymentInfo = [
      {
        "Nomor Invoice": invoice.id,
        "Waktu Pembayaran": invoice.paymentDate,
        "Metode Pembayaran": invoice.paymentMethod,
        "Nomor Resi": invoice.shipping.resi || "Belum diisi",
      },
    ];

    const columnWidths = [120, 150, 120, 150]; // Lebar kolom untuk setiap field
    const columnPositions = [50]; // Posisi awal kolom

    // Hitung posisi x setiap kolom
    columnWidths.forEach((width, index) => {
      columnPositions.push(columnPositions[index] + width);
    });

    // Header Tabel Pembayaran (Tanpa Warna Latar Belakang)
    const paymentTableHeaderY = y;
    doc
      .fontSize(10)
      .fillColor(primaryColor) // Warna teks header
      .text("Nomor Invoice", columnPositions[0], paymentTableHeaderY + 8, { align: "left" })
      .text("Waktu Pembayaran", columnPositions[1] + 10, paymentTableHeaderY + 8, { align: "left" })
      .text("Metode Pembayaran", columnPositions[2] + 10, paymentTableHeaderY + 8, { align: "left" })
      .text("Nomor Resi", columnPositions[3] + 30, paymentTableHeaderY + 8, { align: "left" });

    y += 30;

    // Isi Tabel Pembayaran (Tanpa Garis)
    paymentInfo.forEach((info, index) => {
      const rowY = y + index * 25;

      // Isi baris
      doc.fillColor("#202124")
        .fontSize(10)
        .text(info["Nomor Invoice"], columnPositions[0], rowY, { align: "left" })
        .text(info["Waktu Pembayaran"], columnPositions[1] + 10, rowY, { align: "left" })
        .text(info["Metode Pembayaran"], columnPositions[2] + 10, rowY, { align: "left" })
        .text(info["Nomor Resi"], columnPositions[3] + 30, rowY, { align: "left" });
    });

    y += paymentInfo.length * 25 + 20;

    // Tabel Produk
    const tableHeaderY = y;
    const productColumnWidths = [40, 200, 60, 100, 120]; // Lebar kolom: No, Produk, Qty, Harga, Subtotal
    const productColumnPositions = [50]; // Posisi awal kolom

    // Hitung posisi x setiap kolom
    productColumnWidths.forEach((width, index) => {
      productColumnPositions.push(productColumnPositions[index] + width);
    });

    // Header Tabel Produk
    doc
      .rect(50, tableHeaderY, 500, 25) // Lebar tabel
      .fill(primaryColor);

    // Teks header tabel produk
    doc.fontSize(10)
      .fillColor("#ffffff")
      .text("NO", productColumnPositions[0] + 10, tableHeaderY + 8, { align: "left" })
      .text("PRODUK", productColumnPositions[1] + 10, tableHeaderY + 8, { align: "left" })
      .text("Qty", productColumnPositions[2] + 10, tableHeaderY + 8, { align: "left" })
      .text("HARGA", productColumnPositions[3] + 10, tableHeaderY + 8, { align: "left" })
      .text("SUB TOTAL", productColumnPositions[4] + 10, tableHeaderY + 8, { align: "left" });

    y += 30;

    // Isi Tabel Produk
    invoice.items.forEach((item, index) => {
      const rowY = y + index * 25;

      // Garis horizontal
      doc.moveTo(50, rowY - 5)
        .lineTo(550, rowY - 5)
        .lineWidth(0.5)
        .strokeColor('#e3e4e2') // Garis horizontal abu-abu
        .stroke();

      // Isi baris
      doc.fillColor("#202124")
        .fontSize(10)
        .text(index + 1, productColumnPositions[0] + 10, rowY, { align: "left" })
        .text(item.name, productColumnPositions[1] + 10, rowY, { align: "left" })
        .text(item.qty.toString(), productColumnPositions[2] + 10, rowY, { align: "left" })
        .text(`Rp${item.price.toLocaleString("id-ID")}`, productColumnPositions[3] + 10, rowY, {
          align: "left",
        })
        .text(`Rp${item.subtotal.toLocaleString("id-ID")}`, productColumnPositions[4] + 10, rowY, {
          align: "left",
        });
    });

    // Garis tepi tabel produk
    doc.moveTo(50, tableHeaderY)
      .lineTo(50, y + invoice.items.length * 25 - 5) // Garis kiri
      .lineTo(550, y + invoice.items.length * 25 - 5) // Garis bawah
      .lineTo(550, tableHeaderY) // Garis kanan
      .strokeColor(primaryColor)
      .lineWidth(1)
      .stroke();

    y += invoice.items.length * 25 + 20;

    const startXLabel = 300; // Posisi label (kiri)
    const startXValue = 450; // Posisi nilai (kanan)
    // Informasi Pengiriman (Format left-right)
    doc
      .fillColor(primaryColor)
      .fontSize(12)
      .text("Informasi Pengiriman", startXLabel, y);

    y += 20;

    const totalHargaProduk = invoice.items.reduce((total, item) => total + item.subtotal, 0);
    const totalOngkir = invoice.shipping.finalCost;
    const totalDiskonOngkir = invoice.shipping.discount || 0;
    const totalPembayaran = totalHargaProduk + totalOngkir - totalDiskonOngkir;

    // Fungsi untuk menggambar garis sesuai panjang teks terpanjang
    const drawLine = (texts, x, y) => {
      const maxTextWidth = Math.max(...texts.map(text => doc.widthOfString(text)));
      doc
        .moveTo(x, y)
        .lineTo(x + maxTextWidth, y)
        .lineWidth(1)
        .strokeColor(secondaryColor)
        .stroke();
    };

    // SUB TOTAL PRODUK
    const subtotalProdukText = `SUB TOTAL PRODUK : Rp${totalHargaProduk.toLocaleString("id-ID")}`;
    // SUB TOTAL PRODUK
doc
  .text("SUB TOTAL PRODUK", startXLabel, y, { align: "left" })
  .text(`Rp${totalHargaProduk.toLocaleString("id-ID")}`, startXValue, y, { align: "right",width: 100 // Batasi lebar teks agar tidak wrap
  });

    y += 20;

    // SUB TOTAL ONGKIR
    const subtotalOngkirText = `SUB TOTAL ONGKIR : Rp${totalOngkir.toLocaleString("id-ID")}`;
    doc
      .text("SUB TOTAL ONGKIR", startXLabel, y, { align: "left" })
      .text(`Rp${totalOngkir.toLocaleString("id-ID")}`, startXValue, y, { align: "right",width: 100 // Batasi lebar teks agar tidak wrap
      });

    y += 20;

    // TOTAL DISKON ONGKIR
    const totalDiskonOngkirText = `TOTAL DISKON ONGKIR : -Rp${totalDiskonOngkir.toLocaleString("id-ID")}`;
    doc
      .text("TOTAL DISKON ONGKIR", startXLabel, y, { align: "left" })
      .text(`-Rp${totalDiskonOngkir.toLocaleString("id-ID")}`, startXValue, y, { align: "right",width: 100 // Batasi lebar teks agar tidak wrap
      });

    y += 20;

    // Garis pembatas (panjang otomatis menyesuaikan teks terpanjang)
    const texts = [subtotalProdukText, subtotalOngkirText, totalDiskonOngkirText];
    drawLine(texts, 350, y);

    y += 20;

    // TOTAL PEMBAYARAN
    doc
      .font("Helvetica-Bold")
      .text("TOTAL PEMBAYARAN", startXLabel, y, { align: "left" })
      .text(`Rp${totalPembayaran.toLocaleString("id-ID")}`, startXValue, y, { align: "right",width: 100 // Batasi lebar teks agar tidak wrap
      });

    y += 40;

     // Footer (Posisi Paling Bawah dan Tengah)
     const footerY = doc.page.height - 100; // Posisi y untuk footer (100 dari bawah)
     doc
       .fillColor(secondaryColor)
       .fontSize(9)
       .text("Terima kasih telah berbelanja di Si Cantik Herbal.", { align: "center", y: footerY })
       .text("Barang yang sudah dibeli tidak dapat dikembalikan.", { align: "center", y: footerY + 15 });
 
    doc.end();
  });
};
module.exports = {
  waitForUserResponse,
  checkShippingCost,
  parseProductsInput,
  showInvoiceConfirmation,
  saveInvoiceToSheet,
  getInvoicesByPhone,
  getInvoiceById,
  updateInvoiceStatus,
  generateInvoicePDF,
};
