const axios = require('axios');

// Fungsi untuk mengambil data produk
const getProducts = async () => {
    try {
        const response = await axios.get(`${process.env.APP_SCRIPT_URL}?action=get&sheet=produk`);

        // Debug: Tampilkan data dari Apps Script
        console.log("Data dari Apps Script:", response.data);

        if (!Array.isArray(response.data)) {
            throw new Error("Data produk tidak valid: Bukan array.");
        }

        // Filter produk dengan stok "Ready"
        const readyProducts = response.data.filter(product => product.Stok.toLowerCase() === 'ready');
        return readyProducts;
    } catch (error) {
        console.error("Gagal mengambil data produk:", error.message);
        throw error;
    }
};

// Fungsi untuk menampilkan daftar produk
const sendProductList = async (sock, sender) => {
    try {
        const products = await getProducts();

        // Kelompokkan produk berdasarkan kategori
        const categorizedProducts = products.reduce((acc, product) => {
            const category = product.Kategori || "Lainnya";
            if (!acc[category]) acc[category] = [];
            acc[category].push(product);
            return acc;
        }, {});

        // Jika tidak ada produk ready
        if (Object.keys(categorizedProducts).length === 0) {
            await sock.sendMessage(sender, { 
                text: "📭 Maaf, stok semua produk sedang kosong." 
            });
            return;
        }

        // Format pesan
        let productList = "🛍️ *DAFTAR PRODUK TOKO KAMI* 🛍️\n\n";
        for (const category in categorizedProducts) {
            productList += `*${category.toUpperCase()}*\n`;
            categorizedProducts[category].forEach((product, index) => {
                productList += `${index + 1}. ${product["Nama Produk"]} - Rp${product.Harga.toLocaleString()}\n`;
            });
            productList += "\n";
        }
        productList += "➖➖➖➖➖➖➖➖➖➖➖➖";

        // Kirim pesan
        await sock.sendMessage(sender, { text: productList });
        await sock.sendMessage(sender, { 
            text: "Ketik *nama produk* untuk melihat detail.\nContoh: *Burhanrex*" 
        });

    } catch (error) {
        console.error(error);
        await sock.sendMessage(sender, { 
            text: "⚠️ Gagal mengambil data produk. Silakan coba lagi nanti." 
        });
    }
};

// Fungsi untuk menampilkan detail produk (DENGAN SATUAN)
const sendProductDetail = async (sock, sender, productName) => {
    try {
        await sock.sendMessage(sender, { text: "⏳ *Wait...* Sedang memproses data produk." });

        const products = await getProducts();
        const product = products.find(p => 
            p["Nama Produk"].toLowerCase() === productName.toLowerCase()
        );

        if (product) {
            // Format pesan detail produk (TAMPILKAN SATUAN)
            const productDetail = `
📌 *Detail Produk:*
➖➖➖➖➖➖➖➖➖➖
🛒 *Nama Produk:* ${product["Nama Produk"]}
💵 *Harga:* Rp${product.Harga.toLocaleString()}
📦 *Satuan:* ${product.Satuan || "-"} 
📝 *Manfaat:* ${product.Manfaat}
➖➖➖➖➖➖➖➖➖➖
            `;

            // Kirim gambar
if (product["Foto URL"]) {
    // Ambil ID file dari URL Google Drive
    const fileIdMatch = product["Foto URL"].match(/(?:id=)([a-zA-Z0-9_-]+)/);

    if (fileIdMatch && fileIdMatch[1]) {
        // Membentuk URL gambar langsung
        const directImageUrl = `https://drive.google.com/uc?export=view&id=${fileIdMatch[1]}`;

        await sock.sendMessage(sender, { 
            image: { url: directImageUrl },
            caption: productDetail
        });
    } else {
        console.error("Error: Tidak dapat menemukan ID file di URL:", product["Foto URL"]);
        await sock.sendMessage(sender, { text: "URL foto tidak valid atau tidak ditemukan." });
    }
} else {
    await sock.sendMessage(sender, { text: productDetail });
}


            // Pesan lanjutan
            await sock.sendMessage(sender, {
                text: "🛒 Ketik nama produk lain untuk melihat detail lainnya.\nKetik .invoice untuk lanjut pembuatan invoice\n📋 Ketik .menu untuk kembali ke menu utama."
            });

        } else {
            await sock.sendMessage(sender, { text: "❌ Produk tidak ditemukan." });
        }

    } catch (error) {
        console.error(error);
        await sock.sendMessage(sender, { 
            text: "⚠️ Gagal mengambil detail produk. Silakan coba lagi nanti." 
        });
    }
};

module.exports = {
    getProducts,
    sendProductList,
    sendProductDetail
};