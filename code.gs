function doGet(e) {
  const action = e.parameter.action;
  const sheetName = e.parameter.sheet;

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet;

  // Pilih sheet berdasarkan parameter
  switch (sheetName) {
    case 'produk':
      sheet = spreadsheet.getSheetByName('DATA PRODUK');
      break;
    case 'ongkir':
      sheet = spreadsheet.getSheetByName('DATA ONGKIR');
      break;
    case 'pesanan':
      sheet = spreadsheet.getSheetByName('DATA PESANAN');
      break;
    default:
      return ContentService.createTextOutput(JSON.stringify({ error: 'Sheet tidak ditemukan' }))
        .setMimeType(ContentService.MimeType.JSON);
  }

  // Jika sheet tidak ditemukan, kembalikan error
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Sheet tidak ditemukan' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  let result;

  // Handle action berdasarkan parameter
  switch (action) {
    case 'get':
      result = data.slice(1).map(row => {
        const obj = {};
        headers.forEach((header, index) => {
          obj[header] = row[index];
        });
        return obj;
      });
      break;

    case 'update':
      const id = e.parameter.id;
      const status = e.parameter.status;

      // Cari baris yang sesuai dengan ID
      const rowIndex = data.findIndex(row => row[headers.indexOf('ID Pesanan')] === id);
      if (rowIndex === -1) {
        return ContentService.createTextOutput(JSON.stringify({ error: 'Pesanan tidak ditemukan' }))
          .setMimeType(ContentService.MimeType.JSON);
      }

      // Update status pesanan
      sheet.getRange(rowIndex + 2, headers.indexOf('Status') + 1).setValue(status);
      result = { success: true, message: 'Status berhasil diupdate' };
      break;

    default:
      result = { error: 'Action tidak valid' };
  }

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName('DATA PESANAN'); // Gunakan sheet DATA PESANAN untuk menyimpan invoice

  // Jika sheet tidak ditemukan, kembalikan error
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Sheet DATA PESANAN tidak ditemukan' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const data = JSON.parse(e.postData.contents);

   // Validasi action
  if (data.action !== 'save') {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Action tidak valid' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

   // Ambil data dari request
  const invoiceData = data.data;

  // Pastikan products.items ada
  if (!invoiceData.products || !invoiceData.products.items) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Data produk tidak valid' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Format data untuk disimpan ke spreadsheet
  const rowData = [
    'INV-' + new Date().getTime(), // ID Pesanan (contoh: INV-1695225600000)
    invoiceData.name,              // Nama Pembeli
    invoiceData.phone,             // No. Telepon
    invoiceData.address,           // Alamat
    invoiceData.province,          // Provinsi
    invoiceData.shipping.finalCost, // Ongkir
    'DRAFT',                       // Status (default: DRAFT)
    '',                            // No. Resi (kosong saat pertama kali disimpan)
    invoiceData.products.items.map(item => `${item.name} (${item.qty}x)`).join(', ') // Produk
  ];

  // Simpan data ke spreadsheet
  sheet.appendRow(rowData);

  // Kirim respons sukses
  return ContentService.createTextOutput(JSON.stringify({ success: true, message: 'Invoice berhasil disimpan' }))
    .setMimeType(ContentService.MimeType.JSON);
}
