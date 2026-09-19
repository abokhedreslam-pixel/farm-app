/*
  Google Apps Script — إدارة المزرعة
  نسخة مدموجة v10.12 Collections + Profit Waterfall:
  - تحافظ على شيتات الدورات وديون العملاء الموجودة عندك
  - تحافظ على Telegram backup والملخصات والتريجرز
  - تضيف مزامنة كاملة بين الموبايل والكمبيوتر للتطبيق v10.5 PWA Sync

  مهم:
  1) لا ترفع هذا الملف على GitHub وفيه توكن حقيقي.
  2) التوكن القديم اتكشف في الشات، الأفضل تعمله Revoke من BotFather وتضع توكن جديد هنا.
  3) بعد اللصق في Apps Script اعمل Deploy > Manage deployments > Edit > New version > Deploy.
*/

var TELEGRAM_BOT_TOKEN = '8509270999:AAGMCzOZ1jHk1hEGAPUyE_8u6L-YRTzK1Ls';
var TELEGRAM_CHAT_ID = '1247562366';
var FARM_TIMEZONE = 'Africa/Cairo';

// اختياري: لو كتبت رمز هنا، اكتب نفس الرمز في إعدادات التطبيق في خانة "رمز حماية المزامنة".
// لو سيبته فاضي، المزامنة تشتغل بدون رمز.
var FARM_SYNC_TOKEN = '';

// شيت مخفي لتخزين قاعدة بيانات التطبيق الكاملة لتزامن الموبايل والكمبيوتر.
var FARM_SYNC_SHEET_NAME = '__farm_sync_db';

// شيت اختياري لتسجيل عمليات سداد العملاء القادمة من التطبيق.
var FARM_PAYMENT_LOG_SHEET = 'دفتر التحصيلات';


function doPost(e) {
  try {
    var params = (e && e.parameter) || {};

    // طلب إرسال نسخة إلى Telegram من زر البرنامج
    if (params.action === 'telegram_backup') {
      return createJsonResponse(
        sendTelegramFullBackup()
      );
    }

    var rawData = '';

    if (params.data) {
      rawData = params.data;
    } else if (
      e &&
      e.postData &&
      e.postData.contents
    ) {
      rawData = e.postData.contents;
    }

    if (!rawData) {
      return createJsonResponse({
        success: false,
        ok: false,
        message: 'لم يتم إرسال بيانات'
      });
    }

    var data = JSON.parse(rawData);

    var action =
      params.action ||
      data.action ||
      '';

    /*
      ======================================================
      مزامنة كاملة بين الأجهزة — موبايل / كمبيوتر
      ======================================================
    */
    if (action === 'farm_full_db') {
      if (!isAuthorized_(params, data)) {
        return createJsonResponse({
          success: false,
          ok: false,
          message: 'رمز الحماية غير صحيح'
        });
      }

      var incomingDb = data.db || {};

      if (
        !incomingDb ||
        !Array.isArray(incomingDb.cycles) ||
        !Array.isArray(incomingDb.sales)
      ) {
        return createJsonResponse({
          success: false,
          ok: false,
          message: 'قاعدة البيانات غير صالحة'
        });
      }

      var currentDb = readCloudDb_();
      var incomingCount = businessCountServer_(incomingDb);
      var currentCount = currentDb ? businessCountServer_(currentDb) : 0;

      // حماية: لا تسمح لجهاز فاضي يكتب فوق نسخة سحابية فيها بيانات بسبب حفظ الإعدادات فقط.
      if (
        currentDb &&
        currentCount > 0 &&
        incomingCount === 0 &&
        !data.forceClear
      ) {
        return createJsonResponse({
          success: true,
          ok: true,
          saved: false,
          ignoredEmptyOverwrite: true,
          message: 'تم تجاهل رفع قاعدة فاضية لأن السحابة تحتوي بيانات'
        });
      }

      // لو المستخدم اختار من التطبيق: رفع هذا الجهاز كنسخة أساسية، نستبدل السحابة بالكامل.
      // استخدمها مرة واحدة بعد تنظيف البيانات المحلية من سجلات قديمة رجعت من السحابة.
      var dbToSave = data.forceReplace
        ? incomingDb
        : (
            currentDb
              ? mergeDbsServer_(currentDb, incomingDb)
              : incomingDb
          );

      dbToSave.meta = dbToSave.meta || {};
      dbToSave.meta.updatedAt = new Date().toISOString();
      dbToSave.meta.schema = 11;

      writeCloudDb_(dbToSave);
      updateSheetsFromFullDb_(dbToSave);

      return createJsonResponse({
        success: true,
        ok: true,
        saved: true,
        merged: !!currentDb,
        updatedAt: dbToSave.meta.updatedAt,
        records: businessCountServer_(dbToSave)
      });
    }

    // تسجيل سداد عميل في شيت مستقل، بدون ما يبوّظ شيت الدورة.
    if (action === 'log_customer_payment') {
      if (!isAuthorized_(params, data)) {
        return createJsonResponse({
          success: false,
          ok: false,
          message: 'رمز الحماية غير صحيح'
        });
      }

      appendPaymentLog_(data);

      return createJsonResponse({
        success: true,
        ok: true,
        logged: true
      });
    }

    /*
      ======================================================
      التوافق مع النسخة القديمة:
      استقبال تقرير دورة واحدة + ديون العملاء وتحديث الشيتات.
      ======================================================
    */
    var cycle = data.cycle || {};

    var sales = Array.isArray(data.sales)
      ? data.sales
      : [];

    var follows = Array.isArray(data.follows)
      ? data.follows
      : [];

    var payments = Array.isArray(data.payments)
      ? data.payments
      : [];

    var expenses = Array.isArray(data.expenses)
      ? data.expenses
      : [];

    var customerDebts =
      Array.isArray(data.customerDebts)
        ? data.customerDebts
        : [];

    var customerDebtsUpdatedAt =
      data.customerDebtsUpdatedAt || '';

    updateCustomerDebtsSheet_(
      customerDebts,
      customerDebtsUpdatedAt
    );

    updateCycleSheet_(
      cycle,
      sales,
      follows,
      payments,
      expenses
    );

    return HtmlService.createHtmlOutput(
      '<html>' +
      '<body style="font-family:sans-serif;text-align:center;padding:50px">' +
      '<h2 style="color:green">تم تحديث الدورة وديون العملاء بنجاح</h2>' +
      '<script>' +
      'setTimeout(function(){window.close()},1500)' +
      '</script>' +
      '</body>' +
      '</html>'
    );

  } catch (error) {
    return HtmlService.createHtmlOutput(
      '<html>' +
      '<body style="font-family:sans-serif;text-align:center;padding:50px">' +
      '<h2 style="color:red">حدث خطأ</h2>' +
      '<p>' +
      escapeHtml_(error.message) +
      '</p>' +
      '</body>' +
      '</html>'
    );
  }
}


function doGet(e) {
  var params = (e && e.parameter) || {};

  if (params.action === 'pull_db') {
    if (!isAuthorized_(params, {})) {
      return createJsonpResponse_(params.callback, {
        ok: false,
        error: 'رمز الحماية غير صحيح'
      });
    }

    var cloudDb = readCloudDb_();

    if (!cloudDb) {
      return createJsonpResponse_(params.callback, {
        ok: true,
        empty: true
      });
    }

    return createJsonpResponse_(params.callback, {
      ok: true,
      empty: false,
      updatedAt:
        (cloudDb.meta && cloudDb.meta.updatedAt) ||
        '',
      deviceId:
        (cloudDb.meta && cloudDb.meta.deviceId) ||
        '',
      db: cloudDb
    });
  }

  return HtmlService.createHtmlOutput(
    '<html>' +
    '<body style="font-family:sans-serif;text-align:center;padding:50px">' +
    '<h2>خادم المزرعة يعمل بنجاح</h2>' +
    '<p>الدوال المتاحة: pull_db / farm_full_db / telegram_backup</p>' +
    '</body>' +
    '</html>'
  );
}


function createJsonResponse(result) {
  return ContentService
    .createTextOutput(
      JSON.stringify(result)
    )
    .setMimeType(
      ContentService.MimeType.JSON
    );
}


function createJsonpResponse_(callback, result) {
  callback = String(callback || '');

  var validCallback =
    /^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/
      .test(callback);

  var body = validCallback
    ? callback + '(' + JSON.stringify(result) + ');'
    : JSON.stringify(result);

  return ContentService
    .createTextOutput(body)
    .setMimeType(
      validCallback
        ? ContentService.MimeType.JAVASCRIPT
        : ContentService.MimeType.JSON
    );
}


function escapeHtml_(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}


function isAuthorized_(params, data) {
  var required =
    String(FARM_SYNC_TOKEN || '').trim();

  if (!required) {
    return true;
  }

  params = params || {};
  data = data || {};

  var got =
    String(
      params.token ||
      params.syncToken ||
      data.syncToken ||
      ''
    ).trim();

  return got === required;
}


function time_(value) {
  var time =
    Date.parse(
      value ||
      '1970-01-01T00:00:00.000Z'
    );

  return isNaN(time) ? 0 : time;
}


function getSpreadsheet_() {
  return SpreadsheetApp
    .getActiveSpreadsheet();
}


function prepareSheet_(sheet) {
  var filter = sheet.getFilter();

  if (filter) {
    filter.remove();
  }

  var lastRow = Math.max(
    sheet.getLastRow(),
    1
  );

  var lastColumn = Math.max(
    sheet.getLastColumn(),
    1
  );

  var mergedRanges = sheet
    .getRange(
      1,
      1,
      lastRow,
      lastColumn
    )
    .getMergedRanges();

  mergedRanges.forEach(function (range) {
    range.breakApart();
  });

  sheet.clearContents();
  sheet.clearFormats();
  sheet.setRightToLeft(true);
}


/*
====================================
Sync storage داخل شيت مخفي
====================================
*/

function getSyncSheet_(createIfMissing) {
  var spreadsheet = getSpreadsheet_();

  var sheet =
    spreadsheet.getSheetByName(
      FARM_SYNC_SHEET_NAME
    );

  if (!sheet && createIfMissing) {
    sheet =
      spreadsheet.insertSheet(
        FARM_SYNC_SHEET_NAME
      );

    try {
      sheet.hideSheet();
    } catch (error) {}
  }

  return sheet;
}


function writeCloudDb_(db) {
  var sheet = getSyncSheet_(true);

  var text =
    JSON.stringify(db || {});

  // حد الخلية في Google Sheets حوالي 50 ألف حرف، لذلك نقسم الـ JSON على صفوف.
  var chunkSize = 45000;
  var rows = [];

  for (
    var i = 0;
    i < text.length;
    i += chunkSize
  ) {
    rows.push([
      rows.length + 1,
      text.slice(i, i + chunkSize)
    ]);
  }

  sheet.clearContents();
  sheet.clearFormats();

  sheet
    .getRange(1, 1, 1, 4)
    .setValues([[
      'updatedAt',
      (db.meta && db.meta.updatedAt) || '',
      'deviceId',
      (db.meta && db.meta.deviceId) || ''
    ]]);

  if (rows.length > 0) {
    sheet
      .getRange(
        2,
        1,
        rows.length,
        2
      )
      .setValues(rows);
  }

  try {
    sheet.hideSheet();
  } catch (error) {}
}


function readCloudDb_() {
  var sheet = getSyncSheet_(false);

  if (!sheet) {
    return null;
  }

  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return null;
  }

  var values = sheet
    .getRange(
      2,
      2,
      lastRow - 1,
      1
    )
    .getValues();

  var text = values
    .map(function (row) {
      return row[0] || '';
    })
    .join('');

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}


function saleTotalFromDb_(sale) {
  return Number(
    sale.total ||
    (
      Number(sale.qty || 0) *
      Number(sale.price || 0)
    ) ||
    0
  );
}


function businessCountServer_(db) {
  db = db || {};

  return [
    'cycles',
    'follows',
    'sales',
    'payments',
    'feed_receipts',
    'expenses',
    'handovers'
  ].reduce(function (sum, key) {
    return sum + (
      Array.isArray(db[key])
        ? db[key].length
        : 0
    );
  }, 0);
}


function syncCollectionsServer_() {
  return [
    'cycles',
    'follows',
    'sales',
    'payments',
    'feed_receipts',
    'expenses',
    'handovers'
  ];
}


function deletedMapServer_(db, key) {
  return ((((db || {}).meta || {}).deleted || {})[key]) || {};
}


function deletedStampServer_(deleted, key, id) {
  return time_(((deleted || {})[key] || {})[id] || '');
}


function mergeDeletedServer_(currentDb, incomingDb) {
  var out = {};

  syncCollectionsServer_().forEach(function (key) {
    out[key] = Object.assign(
      {},
      deletedMapServer_(currentDb, key),
      deletedMapServer_(incomingDb, key)
    );
  });

  return out;
}


function recordStampServer_(record) {
  record = record || {};

  return time_(
    record._syncUpdatedAt ||
    record.updatedAt ||
    record.modifiedAt ||
    record.waivedAt ||
    record.createdAt ||
    record.date ||
    ''
  );
}


function cloneServer_(value) {
  return JSON.parse(
    JSON.stringify(value || {})
  );
}


function mergeArrayServer_(currentArr, incomingArr, deleted, key) {
  var map = {};
  var orderMap = {};

  function put(record) {
    if (!record || !record.id) {
      return;
    }

    var id = String(record.id);
    var old = map[id];

    if (!old) {
      map[id] = cloneServer_(record);
      orderMap[id] = true;
      return;
    }

    var oldStamp = recordStampServer_(old);
    var newStamp = recordStampServer_(record);

    if (newStamp > oldStamp) {
      var merged = cloneServer_(old);
      var incoming = cloneServer_(record);
      Object.keys(incoming).forEach(function (field) {
        merged[field] = incoming[field];
      });
      map[id] = merged;
    }
  }

  (currentArr || []).forEach(put);
  (incomingArr || []).forEach(put);

  return Object
    .keys(orderMap)
    .map(function (id) {
      return map[id];
    })
    .filter(function (record) {
      return deletedStampServer_(deleted, key, record.id) < recordStampServer_(record);
    })
    .sort(function (a, b) {
      return String(a.date || a.createdAt || '')
        .localeCompare(
          String(b.date || b.createdAt || '')
        ) ||
        String(a.id || '')
          .localeCompare(
            String(b.id || '')
          );
    });
}


function mergeDbsServer_(currentDb, incomingDb) {
  currentDb = cloneServer_(currentDb || {});
  incomingDb = cloneServer_(incomingDb || {});

  var merged = cloneServer_(currentDb);
  var deleted = mergeDeletedServer_(currentDb, incomingDb);

  syncCollectionsServer_().forEach(function (key) {
    merged[key] = mergeArrayServer_(
      currentDb[key] || [],
      incomingDb[key] || [],
      deleted,
      key
    );
  });

  merged.settings = Object.assign(
    {},
    currentDb.settings || {},
    incomingDb.settings || {}
  );

  merged.meta = Object.assign(
    {},
    currentDb.meta || {},
    incomingDb.meta || {}
  );

  merged.meta.deleted = deleted;

  return merged;
}


function normNameServer_(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}


function feedStatsServer_(feedReceipts, follows) {
  feedReceipts = Array.isArray(feedReceipts) ? feedReceipts : [];
  follows = Array.isArray(follows) ? follows : [];

  feedReceipts = feedReceipts
    .slice()
    .sort(function (a, b) {
      return String(a.date || '')
        .localeCompare(String(b.date || '')) ||
        String(a.id || '')
          .localeCompare(String(b.id || ''));
    });

  var consumed = follows.reduce(function (sum, item) {
    return sum + Number(item.feed_used || 0);
  }, 0);

  var received = feedReceipts.reduce(function (sum, item) {
    return sum + Number(item.qty || 0);
  }, 0);

  var receivedCost = feedReceipts.reduce(function (sum, item) {
    return sum +
      Number(item.qty || 0) *
      Number(item.price || 0);
  }, 0);

  var left = consumed;
  var cost = 0;

  feedReceipts.forEach(function (receipt) {
    var qty = Number(receipt.qty || 0);
    var price = Number(receipt.price || 0);
    var take = Math.min(left, qty);
    cost += take * price;
    left -= take;
  });

  if (left > 0.009) {
    var lastPrice = feedReceipts.length
      ? Number(feedReceipts[feedReceipts.length - 1].price || 0)
      : 0;
    cost += left * lastPrice;
  }

  return {
    received: received,
    consumed: consumed,
    receivedCost: receivedCost,
    cost: cost,
    avgUsedPrice: consumed > 0 ? cost / consumed : 0
  };
}


function updateCollectionsLedgerSheet_(db) {
  db = db || {};

  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(FARM_PAYMENT_LOG_SHEET);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(FARM_PAYMENT_LOG_SHEET);
  }

  prepareSheet_(sheet);

  var cycles = Array.isArray(db.cycles) ? db.cycles : [];
  var sales = Array.isArray(db.sales) ? db.sales : [];
  var payments = Array.isArray(db.payments) ? db.payments : [];

  var cyclesById = {};
  cycles.forEach(function (cycle) {
    cyclesById[cycle.id] = cycle;
  });

  var salesById = {};
  sales.forEach(function (sale) {
    salesById[sale.id] = sale;
  });

  var headers = [[
    'م',
    'التاريخ',
    'الوقت',
    'الدورة',
    'اسم العميل / التاجر',
    'نوع العميل',
    'المبلغ المحصّل',
    'المحصل',
    'نوع التحصيل',
    'ملاحظة',
    'رقم عملية التحصيل',
    'وقت التسجيل'
  ]];

  sheet.getRange(1, 1, 1, 12)
    .setValues(headers)
    .setFontWeight('bold')
    .setBackground('#123d2a')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');

  var rows = payments
    .slice()
    .sort(function (a, b) {
      return String(b.date || '')
        .localeCompare(String(a.date || '')) ||
        String(b.createdAt || '')
          .localeCompare(String(a.createdAt || ''));
    })
    .map(function (payment, index) {
      var sale = salesById[payment.saleId] || {};
      var cycle = cyclesById[sale.cycleId] || {};
      var dateValue = payment.date || '';
      var dateOnly = '';
      var timeOnly = '';

      if (dateValue) {
        var parsed = new Date(dateValue);
        if (!isNaN(parsed.getTime())) {
          dateOnly = parsed;
          timeOnly = Utilities.formatDate(parsed, FARM_TIMEZONE, 'HH:mm:ss');
        } else {
          dateOnly = dateValue;
        }
      }

      var paymentKind = payment.batchId
        ? 'دفعة مجمعة'
        : (/كاش/.test(String(payment.note || '')) ? 'كاش مع البيع' : 'سداد');

      return [
        index + 1,
        dateOnly,
        timeOnly,
        cycle.num ? ('#' + cycle.num) : '',
        payment.clientName || sale.name || '',
        sale.clientType || '',
        Number(payment.amount || 0),
        payment.collector || '',
        paymentKind,
        payment.note || '',
        payment.id || '',
        payment.createdAt ? new Date(payment.createdAt) : ''
      ];
    });

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 12).setValues(rows);
    sheet.getRange(2, 2, rows.length, 1).setNumberFormat('dd/MM/yyyy');
    sheet.getRange(2, 7, rows.length, 1)
      .setNumberFormat('#,##0.00 "جنيه"')
      .setFontColor('#08733d')
      .setFontWeight('bold');
    sheet.getRange(2, 12, rows.length, 1).setNumberFormat('dd/MM/yyyy HH:mm:ss');

    var totalRow = rows.length + 2;
    sheet.getRange(totalRow, 1, 1, 6)
      .merge()
      .setValue('إجمالي التحصيلات')
      .setFontWeight('bold')
      .setBackground('#e6f5ec');
    sheet.getRange(totalRow, 7)
      .setFormula('=SUM(G2:G' + (totalRow - 1) + ')')
      .setNumberFormat('#,##0.00 "جنيه"')
      .setFontWeight('bold')
      .setFontColor('#08733d')
      .setBackground('#e6f5ec');
    sheet.getRange(totalRow, 8, 1, 5).setBackground('#e6f5ec');

    sheet.getRange(1, 1, rows.length + 1, 12).createFilter();
  } else {
    sheet.getRange(2, 1).setValue('لا توجد تحصيلات مسجلة حتى الآن');
  }

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 55);
  sheet.setColumnWidth(2, 115);
  sheet.setColumnWidth(3, 90);
  sheet.setColumnWidth(4, 80);
  sheet.setColumnWidth(5, 210);
  sheet.setColumnWidth(6, 95);
  sheet.setColumnWidth(7, 140);
  sheet.setColumnWidth(8, 150);
  sheet.setColumnWidth(9, 120);
  sheet.setColumnWidth(10, 220);
  sheet.setColumnWidth(11, 170);
  sheet.setColumnWidth(12, 165);
}


function updateSheetsFromFullDb_(db) {
  db = db || {};

  var cycles =
    Array.isArray(db.cycles)
      ? db.cycles
      : [];

  var sales =
    Array.isArray(db.sales)
      ? db.sales
      : [];

  var follows =
    Array.isArray(db.follows)
      ? db.follows
      : [];

  var payments =
    Array.isArray(db.payments)
      ? db.payments
      : [];

  var expenses =
    Array.isArray(db.expenses)
      ? db.expenses
      : [];

  var feedReceipts =
    Array.isArray(db.feed_receipts)
      ? db.feed_receipts
      : [];

  updateCollectionsLedgerSheet_(db);

  var customerDebts =
    buildCustomerDebtsFromDb_(db);

  updateCustomerDebtsSheet_(
    customerDebts,
    new Date().toISOString()
  );

  cycles.forEach(function (cycle) {
    var cycleSales = sales
      .filter(function (sale) {
        return sale.cycleId === cycle.id;
      })
      .map(function (sale) {
        var copy = Object.assign({}, sale);
        copy.total = saleTotalFromDb_(sale);
        return copy;
      });

    var cycleSaleIds = {};

    cycleSales.forEach(function (sale) {
      cycleSaleIds[sale.id] = true;
    });

    var cyclePayments =
      payments.filter(function (payment) {
        return cycleSaleIds[payment.saleId];
      });

    var cycleFollows =
      follows.filter(function (follow) {
        return follow.cycleId === cycle.id;
      });

    var cycleExpenses =
      expenses.filter(function (expense) {
        return expense.cycleId === cycle.id;
      });

    var cycleFeedReceipts =
      feedReceipts.filter(function (receipt) {
        return receipt.cycleId === cycle.id;
      });

    updateCycleSheet_(
      cycle,
      cycleSales,
      cycleFollows,
      cyclePayments,
      cycleExpenses,
      cycleFeedReceipts
    );
  });
}


function buildCustomerDebtsFromDb_(db) {
  db = db || {};

  var cycles =
    Array.isArray(db.cycles)
      ? db.cycles
      : [];

  var sales =
    Array.isArray(db.sales)
      ? db.sales
      : [];

  var payments =
    Array.isArray(db.payments)
      ? db.payments
      : [];

  var cyclesById = {};

  cycles.forEach(function (cycle) {
    cyclesById[cycle.id] = cycle;
  });

  var paymentsBySale = {};

  payments.forEach(function (payment) {
    if (!paymentsBySale[payment.saleId]) {
      paymentsBySale[payment.saleId] = [];
    }

    paymentsBySale[payment.saleId].push(payment);
  });

  var groups = {};

  sales.forEach(function (sale) {
    var key = normNameServer_(
      sale.name || 'بدون اسم'
    );

    if (!groups[key]) {
      groups[key] = {
        key: key,
        name:
          String(
            sale.name || 'بدون اسم'
          ).trim(),
        salesCount: 0,
        qty: 0,
        total: 0,
        paid: 0,
        remain: 0,
        cycles: {},
        lastPaymentDate: '',
        lastCollector: ''
      };
    }

    var group = groups[key];

    var saleTotal = saleTotalFromDb_(sale);

    var salePayments =
      paymentsBySale[sale.id] || [];

    var salePaid = salePayments.reduce(
      function (sum, payment) {
        return (
          sum +
          Number(payment.amount || 0)
        );
      },
      0
    );

    var waived =
      Number(sale.waived || 0);

    var remain =
      Math.max(
        0,
        saleTotal - salePaid - waived
      );

    group.salesCount++;
    group.qty += Number(sale.qty || 0);
    group.total += saleTotal;
    group.paid += salePaid;
    group.remain += remain;

    if (remain > 0.009) {
      var cycle = cyclesById[sale.cycleId] || {};

      var cycleKey = sale.cycleId || 'x';

      if (!group.cycles[cycleKey]) {
        group.cycles[cycleKey] = {
          num: cycle.num || '-',
          date: cycle.date || '',
          remain: 0
        };
      }

      group.cycles[cycleKey].remain += remain;
    }

    salePayments.forEach(function (payment) {
      var paymentDate = payment.date || '';

      if (
        paymentDate &&
        (
          !group.lastPaymentDate ||
          String(paymentDate) >
          String(group.lastPaymentDate)
        )
      ) {
        group.lastPaymentDate = paymentDate;
        group.lastCollector = payment.collector || '';
      }
    });
  });

  return Object
    .keys(groups)
    .map(function (key) {
      var group = groups[key];

      var breakdown = Object
        .keys(group.cycles)
        .map(function (cycleKey) {
          return group.cycles[cycleKey];
        })
        .sort(function (a, b) {
          return String(a.date)
            .localeCompare(
              String(b.date)
            );
        })
        .map(function (cycle) {
          return (
            '#' +
            cycle.num +
            ': ' +
            formatMoney_(cycle.remain)
          );
        })
        .join(' ← ');

      return {
        name: group.name,
        salesCount: group.salesCount,
        qty: group.qty,
        total: group.total,
        paid: group.paid,
        remain: group.remain,
        collectionRate:
          group.total
            ? (
                group.paid /
                group.total *
                100
              )
            : 0,
        cycleBreakdown: breakdown,
        lastPaymentDate: group.lastPaymentDate,
        lastCollector: group.lastCollector
      };
    })
    .sort(function (a, b) {
      return b.remain - a.remain;
    });
}


function appendPaymentLog_(data) {
  data = data || {};

  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(FARM_PAYMENT_LOG_SHEET);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(FARM_PAYMENT_LOG_SHEET);
    sheet.setRightToLeft(true);
    sheet
      .getRange(1, 1, 1, 12)
      .setValues([[
        'م',
        'التاريخ',
        'الوقت',
        'الدورة',
        'اسم العميل / التاجر',
        'نوع العميل',
        'المبلغ المحصّل',
        'المحصل',
        'نوع التحصيل',
        'ملاحظة',
        'رقم عملية التحصيل',
        'وقت التسجيل'
      ]])
      .setFontWeight('bold')
      .setBackground('#123d2a')
      .setFontColor('#ffffff');
  }

  var nextRow = sheet.getLastRow() + 1;

  sheet.appendRow([
    nextRow - 1,
    data.date || '',
    data.time || '',
    data.cycle || '',
    data.customerName || '',
    data.clientType || '',
    Number(data.amount || 0),
    data.collector || '',
    data.kind || 'سداد',
    data.note || 'تسجيل لحظي من التطبيق',
    data.paymentId || '',
    new Date()
  ]);

  sheet.getRange(nextRow, 7)
    .setNumberFormat('#,##0.00 "جنيه"')
    .setFontColor('#08733d')
    .setFontWeight('bold');
  sheet.getRange(nextRow, 12).setNumberFormat('dd/MM/yyyy HH:mm:ss');
}


/*
====================================
شيت الدورة
====================================
*/

function updateCycleSheet_(
  cycle,
  sales,
  follows,
  payments,
  expenses,
  feedReceipts
) {
  var spreadsheet = getSpreadsheet_();

  var sheetName =
    'الدورة #' +
    (cycle.num || '1');

  var sheet =
    spreadsheet.getSheetByName(
      sheetName
    );

  if (!sheet) {
    sheet = spreadsheet.insertSheet(
      sheetName
    );
  }

  prepareSheet_(sheet);

  sheet
    .getRange(1, 1, 1, 2)
    .setValues([[
      'تقرير ' + sheetName,
      ''
    ]]);

  sheet
    .getRange(1, 1)
    .setFontWeight('bold')
    .setFontSize(14)
    .setBackground('#1a9b5a')
    .setFontColor('#ffffff');

  sheet
    .getRange(2, 1, 6, 2)
    .setValues([
      [
        'آخر تحديث',
        new Date()
      ],
      [
        'الحالة',
        cycle.ended
          ? 'منتهية'
          : 'شغالة'
      ],
      [
        'العدد',
        Number(cycle.count || 0)
      ],
      [
        'سعر الجوز',
        Number(
          cycle.chickPrice || 0
        )
      ],
      [
        'تاريخ التنزيل',
        cycle.date || ''
      ],
      [
        'الملاحظات',
        cycle.notes || ''
      ]
    ]);

  sheet
    .getRange(2, 2)
    .setNumberFormat(
      'dd/MM/yyyy HH:mm:ss'
    );

  sheet
    .getRange(5, 2)
    .setNumberFormat(
      '#,##0.00 "جنيه"'
    );

  var dead = 0;
  var sold = 0;
  var totalSales = 0;
  var totalPaid = 0;
  var totalExpenses = 0;
  var feedUsed = 0;

  follows.forEach(function (item) {
    dead += Number(
      item.dead || 0
    );

    feedUsed += Number(
      item.feed_used || 0
    );
  });

  sales.forEach(function (item) {
    sold += Number(
      item.qty || 0
    );

    totalSales += saleTotalFromDb_(item);
  });

  payments.forEach(function (item) {
    totalPaid += Number(
      item.amount || 0
    );
  });

  expenses.forEach(function (item) {
    totalExpenses += Number(
      item.amount || 0
    );
  });

  var feedStats = feedStatsServer_(feedReceipts, follows);
  var chickCost = Number(cycle.count || 0) * Number(cycle.chickPrice || 0);
  var feedCost = Number(feedStats.cost || 0);
  var totalCost = chickCost + feedCost + totalExpenses;
  var netProfit = totalSales - totalCost;
  var resultLabel = netProfit >= 0 ? 'صافي الربح' : 'صافي الخسارة';
  var resultColor = netProfit >= 0 ? '#08733d' : '#c62828';
  var resultBg = netProfit >= 0 ? '#e6f5ec' : '#fde8e8';

  sheet
    .getRange(9, 1, 1, 2)
    .setValues([[
      'ملخص الدورة',
      ''
    ]])
    .setFontWeight('bold')
    .setBackground('#e6f5ec');

  sheet
    .getRange(10, 1, 8, 2)
    .setValues([
      [
        'النافق',
        dead
      ],
      [
        'المباع',
        sold
      ],
      [
        'المتبقي',
        Number(cycle.count || 0) -
        dead -
        sold
      ],
      [
        'إجمالي المبيعات',
        totalSales
      ],
      [
        'المحصل',
        totalPaid
      ],
      [
        'المتبقي للتحصيل',
        totalSales - totalPaid
      ],
      [
        'المصروفات',
        totalExpenses
      ],
      [
        'علف مستهلك',
        feedUsed
      ]
    ]);

  sheet
    .getRange(13, 2, 4, 1)
    .setNumberFormat(
      '#,##0.00 "جنيه"'
    );

  var wfRow = 20;

  sheet
    .getRange(wfRow, 1, 1, 4)
    .setValues([[
      'Profit Waterfall — تحليل الربح',
      '',
      '',
      ''
    ]])
    .setFontWeight('bold')
    .setBackground('#22223B')
    .setFontColor('#ffffff');

  wfRow++;

  sheet
    .getRange(wfRow, 1, 6, 4)
    .setValues([
      ['إجمالي المبيعات', 'دخل', totalSales, 'نقطة البداية'],
      ['تكلفة الكتاكيت', 'خصم تكلفة', chickCost, 'عدد × سعر الجوز'],
      ['تكلفة العلف المستهلك', 'خصم تكلفة', feedCost, 'FIFO من استلامات العلف'],
      ['مصروفات أخرى', 'خصم تكلفة', totalExpenses, 'أدوية / عمالة / نقل / غيره'],
      ['إجمالي التكاليف', 'إجمالي', totalCost, 'كتاكيت + علف + مصروفات'],
      [resultLabel, netProfit >= 0 ? 'ربح' : 'خسارة', Math.abs(netProfit), 'بدون علامة سالب — اللون يوضح النتيجة']
    ]);

  sheet.getRange(wfRow, 3, 6, 1).setNumberFormat('#,##0.00 "جنيه"');
  sheet.getRange(wfRow, 1, 1, 4).setBackground('#e6f5ec').setFontWeight('bold');
  sheet.getRange(wfRow + 1, 1, 3, 4).setBackground('#fff4e6');
  sheet.getRange(wfRow + 4, 1, 1, 4).setBackground('#f2e9e4').setFontWeight('bold');
  sheet.getRange(wfRow + 5, 1, 1, 4).setBackground(resultBg).setFontColor(resultColor).setFontWeight('bold');

  var row = 29;

  sheet
    .getRange(row, 1, 1, 6)
    .setValues([[
      'المتابعة اليومية',
      '',
      '',
      '',
      '',
      ''
    ]])
    .setFontWeight('bold')
    .setBackground('#e6f5ec');

  row++;

  sheet
    .getRange(row, 1, 1, 6)
    .setValues([[
      'التاريخ',
      'العمر',
      'النافق',
      'العلف',
      'الحالة',
      'ملاحظات'
    ]])
    .setFontWeight('bold');

  row++;

  if (follows.length > 0) {
    var followRows =
      follows.map(function (item) {
        return [
          item.date || '',
          item.age || '',
          Number(item.dead || 0),
          Number(
            item.feed_used || 0
          ),
          item.health || '',
          item.notes || ''
        ];
      });

    sheet
      .getRange(
        row,
        1,
        followRows.length,
        6
      )
      .setValues(followRows);

    row += followRows.length;
  }

  row += 2;

  sheet
    .getRange(row, 1, 1, 8)
    .setValues([[
      'المبيعات',
      '',
      '',
      '',
      '',
      '',
      '',
      ''
    ]])
    .setFontWeight('bold')
    .setBackground('#e6f5ec');

  row++;

  sheet
    .getRange(row, 1, 1, 8)
    .setValues([[
      'التاريخ',
      'العميل',
      'النوع',
      'العدد',
      'السعر',
      'الإجمالي',
      'مدفوع',
      'متبقي'
    ]])
    .setFontWeight('bold');

  row++;

  if (sales.length > 0) {
    var saleRows = sales.map(function (sale) {
      var saleTotal = saleTotalFromDb_(sale);

      var paid = payments
        .filter(function (payment) {
          return (
            payment.saleId ===
            sale.id
          );
        })
        .reduce(function (
          sum,
          payment
        ) {
          return (
            sum +
            Number(
              payment.amount || 0
            )
          );
        }, 0);

      return [
        sale.date || '',
        sale.name || '',
        sale.clientType || '',
        Number(sale.qty || 0),
        Number(sale.price || 0),
        saleTotal,
        paid,
        saleTotal - paid
      ];
    });

    sheet
      .getRange(
        row,
        1,
        saleRows.length,
        8
      )
      .setValues(saleRows);

    sheet
      .getRange(
        row,
        5,
        saleRows.length,
        4
      )
      .setNumberFormat(
        '#,##0.00 "جنيه"'
      );

    row += saleRows.length;
  }

  if (expenses.length > 0) {
    row += 2;

    sheet
      .getRange(row, 1, 1, 4)
      .setValues([[
        'المصروفات',
        '',
        '',
        ''
      ]])
      .setFontWeight('bold')
      .setBackground('#e6f5ec');

    row++;

    sheet
      .getRange(row, 1, 1, 4)
      .setValues([[
        'التاريخ',
        'النوع',
        'المبلغ',
        'ملاحظات'
      ]])
      .setFontWeight('bold');

    row++;

    var expenseRows = expenses.map(function (item) {
      return [
        item.date || '',
        item.type || '',
        Number(
          item.amount || 0
        ),
        item.note || ''
      ];
    });

    sheet
      .getRange(
        row,
        1,
        expenseRows.length,
        4
      )
      .setValues(expenseRows);

    sheet
      .getRange(
        row,
        3,
        expenseRows.length,
        1
      )
      .setNumberFormat(
        '#,##0.00 "جنيه"'
      );
  }

  sheet.autoResizeColumns(1, 8);
}


/*
====================================
شيت ديون العملاء
====================================
*/

function updateCustomerDebtsSheet_(
  debts,
  updatedAt
) {
  var spreadsheet = getSpreadsheet_();

  var sheetName = 'ديون العملاء';

  var sheet = spreadsheet.getSheetByName(
    sheetName
  );

  if (!sheet) {
    sheet = spreadsheet.insertSheet(
      sheetName
    );
  }

  prepareSheet_(sheet);

  debts = Array.isArray(debts)
    ? debts
    : [];

  var headers = [[
    'الترتيب',
    'اسم العميل',
    'عدد العمليات',
    'إجمالي الكمية',
    'خد بكام',
    'دفع كام',
    'عليه كام',
    'نسبة السداد',
    'تفصيل الديون من الأقدم',
    'آخر دفعة',
    'آخر محصل',
    'آخر تحديث'
  ]];

  sheet
    .getRange(1, 1, 1, 12)
    .setValues(headers);

  var updateDate = updatedAt
    ? new Date(updatedAt)
    : new Date();

  if (isNaN(updateDate.getTime())) {
    updateDate = new Date();
  }

  var rows = debts.map(
    function (item, index) {
      var lastPaymentDate = '';

      if (item.lastPaymentDate) {
        var parsedDate = new Date(
          item.lastPaymentDate
        );

        if (!isNaN(parsedDate.getTime())) {
          lastPaymentDate = parsedDate;
        }
      }

      return [
        index + 1,
        item.name || '',
        Number(item.salesCount || 0),
        Number(item.qty || 0),
        Number(item.total || 0),
        Number(item.paid || 0),
        Number(item.remain || 0),
        Number(item.collectionRate || 0) / 100,
        item.cycleBreakdown || '',
        lastPaymentDate,
        item.lastCollector || '',
        updateDate
      ];
    }
  );

  if (rows.length > 0) {
    sheet
      .getRange(
        2,
        1,
        rows.length,
        12
      )
      .setValues(rows);

    sheet
      .getRange(
        2,
        5,
        rows.length,
        3
      )
      .setNumberFormat(
        '#,##0 "جنيه"'
      );

    sheet
      .getRange(
        2,
        8,
        rows.length,
        1
      )
      .setNumberFormat('0.0%');

    sheet
      .getRange(
        2,
        10,
        rows.length,
        1
      )
      .setNumberFormat(
        'dd/MM/yyyy HH:mm'
      );

    sheet
      .getRange(
        2,
        12,
        rows.length,
        1
      )
      .setNumberFormat(
        'dd/MM/yyyy HH:mm'
      );

    sheet
      .getRange(
        2,
        6,
        rows.length,
        1
      )
      .setFontColor('#08733d');

    sheet
      .getRange(
        2,
        7,
        rows.length,
        1
      )
      .setFontColor('#c62828')
      .setFontWeight('bold');

    sheet
      .getRange(
        2,
        9,
        rows.length,
        1
      )
      .setWrap(true)
      .setHorizontalAlignment(
        'right'
      );

    sheet
      .getRange(
        1,
        1,
        rows.length + 1,
        12
      )
      .createFilter();

    var totalRow = rows.length + 2;

    sheet
      .getRange(
        totalRow,
        1,
        1,
        4
      )
      .merge();

    sheet
      .getRange(totalRow, 1)
      .setValue('الإجمالي');

    sheet
      .getRange(totalRow, 5)
      .setFormula(
        '=SUM(E2:E' +
        (totalRow - 1) +
        ')'
      );

    sheet
      .getRange(totalRow, 6)
      .setFormula(
        '=SUM(F2:F' +
        (totalRow - 1) +
        ')'
      );

    sheet
      .getRange(totalRow, 7)
      .setFormula(
        '=SUM(G2:G' +
        (totalRow - 1) +
        ')'
      );

    sheet
      .getRange(
        totalRow,
        5,
        1,
        3
      )
      .setNumberFormat(
        '#,##0 "جنيه"'
      );

    sheet
      .getRange(
        totalRow,
        1,
        1,
        12
      )
      .setFontWeight('bold')
      .setBackground('#fde8e8');

  } else {
    sheet
      .getRange(2, 1)
      .setValue(
        'لا توجد ديون مستحقة على العملاء'
      );
  }

  sheet
    .getRange(1, 1, 1, 12)
    .setFontWeight('bold')
    .setBackground('#16763b')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  sheet.setFrozenRows(1);

  sheet.setColumnWidth(1, 75);
  sheet.setColumnWidth(2, 190);
  sheet.setColumnWidth(9, 300);
  sheet.setColumnWidth(10, 170);
  sheet.setColumnWidth(11, 160);
  sheet.setColumnWidth(12, 170);
}


/*
====================================
Telegram
====================================
*/

function getTelegramConfig_() {
  if (
    !TELEGRAM_BOT_TOKEN ||
    TELEGRAM_BOT_TOKEN === 'PUT_NEW_TELEGRAM_BOT_TOKEN_HERE' ||
    TELEGRAM_BOT_TOKEN === 'اكتب_التوكن_الجديد_هنا'
  ) {
    throw new Error(
      'اكتب Token الجديد في أول سطر من الكود'
    );
  }

  if (
    !TELEGRAM_CHAT_ID ||
    TELEGRAM_CHAT_ID === 'PUT_TELEGRAM_CHAT_ID_HERE'
  ) {
    throw new Error(
      'اكتب Telegram Chat ID في أول الكود'
    );
  }

  return {
    token: TELEGRAM_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID
  };
}


function telegramRequest_(
  method,
  payload
) {
  var config = getTelegramConfig_();

  payload.chat_id = config.chatId;

  var response = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' +
    config.token +
    '/' +
    method,
    {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    }
  );

  var responseCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (
    responseCode < 200 ||
    responseCode >= 300
  ) {
    throw new Error(
      'فشل Telegram: ' +
      responseText
    );
  }

  return JSON.parse(responseText);
}


function sendTelegramMessage_(text) {
  return telegramRequest_(
    'sendMessage',
    {
      text: text
    }
  );
}


function sendTelegramDocument_(
  fileBlob,
  caption
) {
  return telegramRequest_(
    'sendDocument',
    {
      document: fileBlob,
      caption: caption || ''
    }
  );
}


function formatMoney_(value) {
  return Number(value || 0)
    .toLocaleString(
      'en-US',
      {
        maximumFractionDigits: 2
      }
    );
}


function getFarmSummary_() {
  var spreadsheet = getSpreadsheet_();

  var debtsSheet = spreadsheet.getSheetByName(
    'ديون العملاء'
  );

  var totalSales = 0;
  var totalPaid = 0;
  var totalDebt = 0;
  var debtorCount = 0;

  if (
    debtsSheet &&
    debtsSheet.getLastRow() >= 2
  ) {
    var values = debtsSheet
      .getRange(
        2,
        5,
        debtsSheet.getLastRow() - 1,
        3
      )
      .getValues();

    values.forEach(function (row) {
      var sales = Number(row[0]) || 0;
      var paid = Number(row[1]) || 0;
      var debt = Number(row[2]) || 0;

      totalSales += sales;
      totalPaid += paid;
      totalDebt += debt;

      if (debt > 0.009) {
        debtorCount++;
      }
    });
  }

  var cycleCount = spreadsheet
    .getSheets()
    .filter(function (sheet) {
      return /^الدورة #/.test(
        sheet.getName()
      );
    })
    .length;

  return {
    totalSales: totalSales,
    totalPaid: totalPaid,
    totalDebt: totalDebt,
    debtorCount: debtorCount,
    cycleCount: cycleCount
  };
}


function buildFarmSummaryMessage_() {
  var summary = getFarmSummary_();

  var now = Utilities.formatDate(
    new Date(),
    FARM_TIMEZONE,
    'dd/MM/yyyy hh:mm a'
  );

  return [
    'ملخص المزرعة',
    '',
    'إجمالي المبيعات: ' +
      formatMoney_(summary.totalSales) +
      ' جنيه',
    'إجمالي المحصل: ' +
      formatMoney_(summary.totalPaid) +
      ' جنيه',
    'ديون العملاء: ' +
      formatMoney_(summary.totalDebt) +
      ' جنيه',
    'عدد العملاء المدينين: ' +
      summary.debtorCount,
    'عدد الدورات: ' +
      summary.cycleCount,
    '',
    'آخر تحديث: ' + now
  ].join('\n');
}


function createExcelBlob_() {
  var spreadsheet = getSpreadsheet_();

  SpreadsheetApp.flush();

  var exportUrl =
    'https://docs.google.com/spreadsheets/d/' +
    spreadsheet.getId() +
    '/export' +
    '?format=xlsx' +
    '&exportFormat=xlsx';

  var response = UrlFetchApp.fetch(
    exportUrl,
    {
      headers: {
        Authorization:
          'Bearer ' +
          ScriptApp.getOAuthToken()
      },
      muteHttpExceptions: true
    }
  );

  var responseCode = response.getResponseCode();

  if (
    responseCode < 200 ||
    responseCode >= 300
  ) {
    throw new Error(
      'فشل تجهيز ملف Excel: ' +
      response.getContentText()
    );
  }

  var stamp = Utilities.formatDate(
    new Date(),
    FARM_TIMEZONE,
    'yyyy-MM-dd_HH-mm'
  );

  return response
    .getBlob()
    .setName(
      'نسخة-المزرعة-' +
      stamp +
      '.xlsx'
    );
}


function createJsonBlob_() {
  var spreadsheet = getSpreadsheet_();

  var backup = {
    spreadsheetName: spreadsheet.getName(),
    spreadsheetId: spreadsheet.getId(),
    createdAt: new Date().toISOString(),
    sheets: []
  };

  spreadsheet
    .getSheets()
    .forEach(function (sheet) {
      var rows = sheet.getLastRow();
      var columns = sheet.getLastColumn();
      var values = [];

      if (
        rows > 0 &&
        columns > 0
      ) {
        values = sheet
          .getRange(
            1,
            1,
            rows,
            columns
          )
          .getDisplayValues();
      }

      backup.sheets.push({
        name: sheet.getName(),
        values: values
      });
    });

  var stamp = Utilities.formatDate(
    new Date(),
    FARM_TIMEZONE,
    'yyyy-MM-dd_HH-mm'
  );

  return Utilities.newBlob(
    JSON.stringify(
      backup,
      null,
      2
    ),
    'application/json',
    'نسخة-المزرعة-' +
      stamp +
      '.json'
  );
}


function sendTelegramFullBackup() {
  try {
    var now = Utilities.formatDate(
      new Date(),
      FARM_TIMEZONE,
      'dd/MM/yyyy hh:mm a'
    );

    sendTelegramMessage_(
      buildFarmSummaryMessage_() +
      '\n\nجاري إرسال ملفات النسخة الاحتياطية...'
    );

    Utilities.sleep(700);

    sendTelegramDocument_(
      createExcelBlob_(),
      'نسخة Excel كاملة للمزرعة\n' +
      now
    );

    Utilities.sleep(700);

    sendTelegramDocument_(
      createJsonBlob_(),
      'نسخة JSON لجميع صفحات الشيت\n' +
      now
    );

    return {
      success: true,
      ok: true,
      message:
        'تم إرسال الملخص وExcel وJSON إلى Telegram'
    };

  } catch (error) {
    console.error(error);

    return {
      success: false,
      ok: false,
      message: error.message
    };
  }
}


function sendTelegramDailySummary() {
  sendTelegramMessage_(
    buildFarmSummaryMessage_()
  );
}


function sendTelegramWeeklyBackup() {
  var result = sendTelegramFullBackup();

  if (!result.success) {
    throw new Error(
      result.message
    );
  }
}


function testTelegramConnection() {
  var now = Utilities.formatDate(
    new Date(),
    FARM_TIMEZONE,
    'dd/MM/yyyy hh:mm a'
  );

  sendTelegramMessage_(
    'تم ربط بوت المزرعة بنجاح.\n' +
    'وقت الاختبار: ' +
    now
  );
}


function setupTelegramAutomation() {
  deleteTelegramTriggers_();

  // الملخص اليومي الساعة 11 مساءً
  ScriptApp
    .newTrigger(
      'sendTelegramDailySummary'
    )
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .nearMinute(0)
    .inTimezone(FARM_TIMEZONE)
    .create();

  // النسخة الأسبوعية الجمعة الساعة 10 مساءً
  ScriptApp
    .newTrigger(
      'sendTelegramWeeklyBackup'
    )
    .timeBased()
    .onWeekDay(
      ScriptApp.WeekDay.FRIDAY
    )
    .atHour(22)
    .nearMinute(0)
    .inTimezone(FARM_TIMEZONE)
    .create();

  sendTelegramMessage_(
    [
      'تم تشغيل نسخ المزرعة التلقائية.',
      '',
      'الملخص اليومي: الساعة 11 مساءً',
      'النسخة الأسبوعية: الجمعة الساعة 10 مساءً',
      'النسخة الأسبوعية: Excel وJSON'
    ].join('\n')
  );
}


function deleteTelegramTriggers_() {
  var handlerNames = [
    'sendTelegramDailySummary',
    'sendTelegramWeeklyBackup'
  ];

  ScriptApp
    .getProjectTriggers()
    .forEach(function (trigger) {
      if (
        handlerNames.indexOf(
          trigger.getHandlerFunction()
        ) !== -1
      ) {
        ScriptApp.deleteTrigger(trigger);
      }
    });
}


/*
====================================
أدوات يدوية للصيانة من داخل Apps Script
====================================
*/

function rebuildAllSheetsFromCloudNow() {
  var db = readCloudDb_();

  if (!db) {
    throw new Error(
      'مفيش نسخة كاملة محفوظة في شيت المزامنة ' +
      FARM_SYNC_SHEET_NAME +
      '. افتح التطبيق من الجهاز اللي عليه البيانات كاملة واضغط مزامنة الآن الأول.'
    );
  }

  updateSheetsFromFullDb_(db);

  return (
    'تم إعادة بناء شيتات الدورات وديون العملاء من نسخة السحابة. ' +
    'الدورات: ' + (Array.isArray(db.cycles) ? db.cycles.length : 0) +
    ' | المبيعات: ' + (Array.isArray(db.sales) ? db.sales.length : 0) +
    ' | الدفعات: ' + (Array.isArray(db.payments) ? db.payments.length : 0)
  );
}


function getCloudDbSummaryNow() {
  var db = readCloudDb_();

  if (!db) {
    return 'لا توجد نسخة كاملة محفوظة في السحابة حتى الآن.';
  }

  var cycles = Array.isArray(db.cycles) ? db.cycles : [];
  var sales = Array.isArray(db.sales) ? db.sales : [];
  var payments = Array.isArray(db.payments) ? db.payments : [];
  var follows = Array.isArray(db.follows) ? db.follows : [];
  var expenses = Array.isArray(db.expenses) ? db.expenses : [];
  var feed = Array.isArray(db.feed_receipts) ? db.feed_receipts : [];
  var handovers = Array.isArray(db.handovers) ? db.handovers : [];

  return [
    'ملخص نسخة السحابة:',
    'آخر تعديل: ' + ((db.meta && db.meta.updatedAt) || '-'),
    'الجهاز: ' + ((db.meta && db.meta.deviceId) || '-'),
    'الدورات: ' + cycles.length,
    'المبيعات: ' + sales.length,
    'الدفعات: ' + payments.length,
    'المتابعات: ' + follows.length,
    'المصروفات: ' + expenses.length,
    'استلامات العلف: ' + feed.length,
    'تسليمات المهني: ' + handovers.length,
    'أرقام الدورات: ' + cycles.map(function (c) { return '#' + c.num; }).join(', ')
  ].join('\n');
}


function clearCloudDbNow() {
  var sheet = getSyncSheet_(false);

  if (!sheet) {
    return 'شيت المزامنة غير موجود أصلًا.';
  }

  sheet.clearContents();
  sheet.clearFormats();

  return 'تم مسح نسخة السحابة. افتح التطبيق من الجهاز الصحيح واضغط رفع هذا الجهاز كنسخة أساسية أو مزامنة الآن.';
}
