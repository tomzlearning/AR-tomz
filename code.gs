function doGet(e) {
  const action = e.parameter.action;
  const sheetName = e.parameter.sheet;

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet;

  // Pilih sheet berdasarkan parameter
  switch (sheetName) {
    case 'produk':
      sheet = spreadsheet.getSheetByName('DATA_PRODUK');
      break;
    case 'ongkir':
      sheet = spreadsheet.getSheetByName('DATA_ONGKIR');
      break;
    case 'pesanan':
      sheet = spreadsheet.getSheetByName('DATA_PESANAN');
      break;
    case 'pemesan':
      sheet = spreadsheet.getSheetByName('DATA_PEMESAN');
      break;
    case 'detail_produk':
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
        (row) => row[headers.indexOf('ID Pesanan')] === id
      );
      
      if (rowIndex === -1) {
        return ContentService.createTextOutput(
          JSON.stringify({ error: 'Pesanan tidak ditemukan' })
        ).setMimeType(ContentService.MimeType.JSON);
      }

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
        requestData.data["Alamat Lengkap"],
        requestData.data["Tanggal Bergabung"]
      ];
      break;

    case 'DATA_PESANAN':
      idPesanan = generateId('INV'); // Generate ID Pesanan
      rowData = [
        idPesanan,
        requestData.data["Nomor WA"],
        requestData.data["Tanggal Pemesanan"],
        requestData.data["Metode Pembayaran"] || "Belum diisi",
        requestData.data["Status Pembayaran"] || "DRAFT",
        requestData.data["Status Pengiriman"] || "Dalam Proses",
        requestData.data["No. Resi"] || "",
        requestData.data["Estimasi Pengiriman"] || "",
        requestData.data["Total Harga"] || 0,
        requestData.data["Alamat Pengiriman"],
        requestData.data["Provinsi"],
        requestData.data["Ongkir"]
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
      idPesanan = requestData.data["ID Pesanan"];

      // Cek apakah produk sudah ada di pesanan yang sama
      const rowIndex = data.findIndex(row => 
        row[0] === idPesanan && 
        row[1] === requestData.data["ID Produk"]
      );

      if (rowIndex !== -1) {
        // Update jumlah jika sudah ada
        const newQty = data[rowIndex][3] + requestData.data["Jumlah"];
        detailSheet.getRange(rowIndex + 1, 4).setValue(newQty);
      } else {
        // Tambahkan baris baru jika belum ada
        rowData = [
          idPesanan, // Gunakan ID Pesanan yang sudah ada
          requestData.data["ID Produk"] || "",
          requestData.data["Nama Produk"],
          requestData.data["Jumlah"],
          requestData.data["Subtotal"]
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
