function doGet(e) {
  const action = e.parameter.action;
  const sheetName = e.parameter.sheet;

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet;

  // Pilih sheet berdasarkan parameter
  switch (sheetName) {
    case 'DATA_PRODUK':
      sheet = spreadsheet.getSheetByName('DATA_PRODUK');
      break;
    case 'DATA_ONGKIR':
      sheet = spreadsheet.getSheetByName('DATA_ONGKIR');
      break;
    case 'DATA_PESANAN':
      sheet = spreadsheet.getSheetByName('DATA_PESANAN');
      break;
    case 'DATA_PEMESAN':
      sheet = spreadsheet.getSheetByName('DATA_PEMESAN');
      break;
    case 'DETAIL_PRODUK_PESANAN':
      sheet = spreadsheet.getSheetByName('DETAIL_PRODUK_PESANAN');
      break;
    default:
      return ContentService.createTextOutput(
        JSON.stringify({ error: 'Sheet tidak ditemukan' })
      ).setMimeType(ContentService.MimeType.JSON);
  }

  if (!sheet) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: 'Sheet tidak ditemukan' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  let result;

  switch (action) {
    case 'get':
      result = data.slice(1).map((row) => {
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
      const rowIndex = data.findIndex(
        (row) => row[headers.indexOf('ID_Pesanan')] === id
      );
      
      if (rowIndex === -1) {
        return ContentService.createTextOutput(
          JSON.stringify({ error: 'Pesanan tidak ditemukan' })
        ).setMimeType(ContentService.MimeType.JSON);
      }

      sheet.getRange(rowIndex + 2, headers.indexOf('Status_Pengiriman') + 1).setValue(status);
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
  const requestData = JSON.parse(e.postData.contents);
  const sheetName = requestData.sheet;
  const action = requestData.action;

  if (action !== 'save') {
    return ContentService.createTextOutput(
      JSON.stringify({ error: 'Action tidak valid' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    return ContentService.createTextOutput(
      JSON.stringify({ error: 'Sheet tidak ditemukan' })
    ).setMimeType(ContentService.MimeType.JSON);
  }

  // Fungsi generate ID untuk DATA_PESANAN
  function generateId(prefix) {
    const date = new Date();
    const formattedDate = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyyMMdd');
    const lastRow = sheet.getLastRow();
    const sequence = lastRow > 1 ? parseInt(sheet.getRange(lastRow, 1).getValue().split('-')[2]) + 1 : 1;
    return `${prefix}-${formattedDate}-${String(sequence).padStart(3, '0')}`;
  }

  // Deklarasikan idPesanan di sini (hanya sekali)
  let idPesanan;

  // Proses data berdasarkan sheet
  let rowData;
  switch (sheetName) {
    case 'DATA_PEMESAN':
      rowData = [
        requestData.data["Nomor WA"],
        requestData.data["Nama Pemesan"],
        requestData.data["Alamat_Utama"],
        requestData.data["Tanggal Bergabung"]
      ];
      break;

    case 'DATA_PESANAN':
  idPesanan = generateId('INV'); // Generate ID Pesanan
  rowData = [
    idPesanan,
    requestData.data["Nomor WA"], // Nomor WA pemesan
    requestData.data["Nama Pemesan"], // Nama pemesan
    requestData.data["Nomor Telepon"], // Nomor telepon pemesan
    requestData.data["Alamat_Pengiriman"], // Alamat pengiriman
    requestData.data["Provinsi"], // Provinsi
    requestData.data["Tanggal Pemesanan"], // Tanggal pemesanan
    requestData.data["Metode Pembayaran"] || "Belum diisi", // Metode pembayaran
    requestData.data["Status Pembayaran"] || "DRAFT", // Status pembayaran
    requestData.data["Status Pengiriman"] || "Dalam Proses", // Status pengiriman
    requestData.data["No_Resi"] || "", // Nomor resi
    requestData.data["Estimasi_Pengiriman"] || "", // Estimasi pengiriman
    requestData.data["Ongkir"] || 0, // Ongkir
    requestData.data["Total_Harga"] || 0, // Total harga
    requestData.data["Catatan"] || "", // Catatan
    requestData.data["Tanggal_Diubah"] || new Date().toISOString() // Tanggal diubah
  ];

  // Simpan data ke sheet
  sheet.appendRow(rowData);

  // Kembalikan ID Pesanan sebagai respons
  return ContentService.createTextOutput(
    JSON.stringify({ success: true, idPesanan: idPesanan })
  ).setMimeType(ContentService.MimeType.JSON);

    case 'DETAIL_PRODUK_PESANAN':
      const detailSheet = spreadsheet.getSheetByName('DETAIL_PRODUK_PESANAN');
      const data = detailSheet.getDataRange().getValues();

      // Ambil ID Pesanan dari request (bukan generate baru)
      idPesanan = requestData.data["ID_Pesanan"];

      // Cek apakah produk sudah ada di pesanan yang sama
      const rowIndex = data.findIndex(row => 
        row[0] === idPesanan && 
        row[1] === requestData.data["ID_Produk"]
      );

      if (rowIndex !== -1) {
        // Update jumlah jika sudah ada
        const newQty = data[rowIndex][4] + requestData.data["Jumlah"]; // Kolom "Jumlah" adalah indeks 4
        detailSheet.getRange(rowIndex + 1, 5).setValue(newQty); // Kolom "Jumlah" adalah indeks 4 (kolom ke-5)
      } else {
        // Tambahkan baris baru jika belum ada
        rowData = [
          idPesanan, // Gunakan ID Pesanan yang sudah ada
          requestData.data["ID_Produk"] || "",
          requestData.data["Nama_Produk"],
          requestData.data["Harga_Saat_Itu"], // Harga Satuan
          requestData.data["Jumlah"], // Jumlah
          requestData.data["Subtotal"] // Subtotal
        ];
        detailSheet.appendRow(rowData);
      }

      return ContentService.createTextOutput(
        JSON.stringify({ success: true, message: 'Data berhasil disimpan' })
      ).setMimeType(ContentService.MimeType.JSON);

    default:
      return ContentService.createTextOutput(
        JSON.stringify({ error: 'Sheet tidak didukung' })
      ).setMimeType(ContentService.MimeType.JSON);
  }

  // Simpan data ke sheet
  if (rowData) {
    sheet.appendRow(rowData);
  }

  return ContentService.createTextOutput(
    JSON.stringify({ success: true, message: 'Data berhasil disimpan' })
  ).setMimeType(ContentService.MimeType.JSON);
}

function autoResizeAllSheets() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = spreadsheet.getSheets(); // Ambil semua sheet

  sheets.forEach(sheet => {
    const lastColumn = sheet.getLastColumn();
    if (lastColumn === 0) return; // Skip sheet kosong

    // Ambil header dari baris pertama
    const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];

    headers.forEach((header, index) => {
      const columnNumber = index + 1;
      const headerText = header.toString().trim();
      
      // Hitung lebar kolom
      const baseWidth = headerText.length * 9; // 9 pixel per karakter
      const padding = 30; // Ruang tambahan
      sheet.setColumnWidth(columnNumber, baseWidth + padding);
    });
  });
}

function setHeaderCenterDataLeft() {
  const sheets = SpreadsheetApp.getActive().getSheets();
  
  sheets.forEach(sheet => {
    const lastColumn = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    
    // Skip sheet kosong
    if (lastColumn === 0 || lastRow === 0) {
      console.log(`Sheet "${sheet.getName()}" diabaikan karena kosong.`);
      return;
    }
    
    // Atur header ke center
    sheet.getRange(1, 1, 1, lastColumn)
      .setHorizontalAlignment("center")
      .setFontWeight("bold"); // Opsional: tebalkan header
    
    // Atur isi data ke left (hanya jika ada data di bawah header)
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, lastColumn)
        .setHorizontalAlignment("left");
    }
  });
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚙️ Custom Tools')
    .addItem('Atur Header Center & Data Left', 'setHeaderCenterDataLeft')
    .addItem('Auto Resize', 'autoResizeAllSheets')
    .addToUi();
}
