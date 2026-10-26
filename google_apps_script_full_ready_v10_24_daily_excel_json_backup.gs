/*
  Google Apps Script — إدارة المزرعة
  نسخة مدموجة v10.24 Daily Excel + JSON Backup:
  - تحافظ على شيتات الدورات وديون العملاء الموجودة عندك
  - تحافظ على Telegram backup والملخصات والتريجرز
  - تضيف مزامنة كاملة بين الموبايل والكمبيوتر للتطبيق v10.5 PWA Sync
  - تضيف تقرير تحصيلات فترة إلى تيليجرام من داخل قسم تسليم المهني
  - تمنع تقريب أنصاف الجنيهات في شيت ديون العملاء وتضيف اختبار توازن الحسابات
  - تضيف مزامنة سجل المراقبة ومخزن العلف العمومي مع حفظ تكاليف الدورات القديمة
  - يبدأ رصيد المخزن العمومي من صفر بدون ترحيل بواقي العلف التاريخية
  - يدمج اختلافات مسافات أسماء العملاء ويصحح اسم أحمد ربيع العسكري
  - يرسل ملف Excel وملف JSON كامل يوميًا تلقائيًا مع إعادة المحاولة عند عودة الاتصال

  مهم:
  1) لا ترفع هذا الملف على GitHub وفيه توكن حقيقي.
  2) التوكن القديم اتكشف في الشات، الأفضل تعمله Revoke من BotFather وتضع توكن جديد هنا.
  3) بعد اللصق في Apps Script اعمل Deploy > Manage deployments > Edit > New version > Deploy.
*/

var TELEGRAM_BOT_TOKEN = '8509270999:AAGMCzOZ1jHk1hEGAPUyE_8u6L-YRTzK1Ls';
var TELEGRAM_CHAT_ID = '-1003714274171';
var FARM_TIMEZONE = 'Africa/Cairo';

// اختياري: لو كتبت رمز هنا، اكتب نفس الرمز في إعدادات التطبيق في خانة "رمز حماية المزامنة".
// لو سيبته فاضي، المزامنة تشتغل بدون رمز.
var FARM_SYNC_TOKEN = '';

// شيت مخفي لتخزين قاعدة بيانات التطبيق الكاملة لتزامن الموبايل والكمبيوتر.
var FARM_SYNC_SHEET_NAME = '__farm_sync_db';

// شيت اختياري لتسجيل عمليات سداد العملاء القادمة من التطبيق.
var FARM_PAYMENT_LOG_SHEET = 'دفتر التحصيلات';
var FARM_FEED_WAREHOUSE_SHEET = 'مخزن العلف';

// إشعارات تيليجرام لكل عملية تحصيل جديدة.
var FARM_TELEGRAM_NOTIFY_PAYMENTS = true;
var FARM_NOTIFIED_PAYMENTS_SHEET = '__farm_notified_payments';

// نسختا Excel وJSON اليوميتان: الساعة 11 مساءً بتوقيت القاهرة، مع إعادة المحاولة كل ساعة حتى النجاح.
var FARM_DAILY_JSON_BACKUP_HOUR = 23;
var FARM_DAILY_JSON_BACKUP_PROPERTY = 'FARM_LAST_DAILY_JSON_BACKUP_DATE';
var FARM_LAST_JSON_BACKUP_DATA_UPDATED_AT_PROPERTY = 'FARM_LAST_JSON_BACKUP_DATA_UPDATED_AT';


function doPost(e) {
  try {
    var params = (e && e.parameter) || {};

    // نسخة يدوية، أو نسخة تلقائية عند عودة الإنترنت بشرط وجود بيانات أحدث من آخر ملف.
    if (
      params.action === 'telegram_backup' ||
      params.action === 'telegram_backup_if_changed'
    ) {
      var backupOnlyIfChanged =
        params.action === 'telegram_backup_if_changed';
      var backupPayload = {};

      try {
        backupPayload = params.data
          ? JSON.parse(params.data)
          : {};
      } catch (backupParseError) {
        backupPayload = {};
      }

      if (!isAuthorized_(params, backupPayload)) {
        return createJsonResponse({
          success: false,
          ok: false,
          message: 'رمز الحماية غير صحيح'
        });
      }

      if (
        backupPayload.db &&
        Array.isArray(backupPayload.db.cycles) &&
        Array.isArray(backupPayload.db.sales)
      ) {
        var backupCurrentDb = readCloudDb_();
        var backupDbToSave = backupCurrentDb
          ? mergeDbsServer_(backupCurrentDb, backupPayload.db)
          : backupPayload.db;
        var backupSourceUpdatedAt = Math.max(
          time_((backupCurrentDb && backupCurrentDb.meta && backupCurrentDb.meta.updatedAt) || ''),
          time_((backupPayload.db.meta && backupPayload.db.meta.updatedAt) || ''),
          time_(backupPayload.updatedAt || '')
        );
        var lastBackupSourceUpdatedAt = time_(
          PropertiesService
            .getScriptProperties()
            .getProperty(FARM_LAST_JSON_BACKUP_DATA_UPDATED_AT_PROPERTY) || ''
        );

        if (
          backupOnlyIfChanged &&
          backupSourceUpdatedAt <= lastBackupSourceUpdatedAt
        ) {
          return createJsonResponse({
            success: true,
            ok: true,
            skipped: true,
            message: 'لا توجد بيانات أحدث من آخر نسخة JSON'
          });
        }

        backupDbToSave.meta = backupDbToSave.meta || {};
        backupDbToSave.meta.updatedAt = new Date().toISOString();
        backupDbToSave.meta.schema = 12;
        writeCloudDb_(backupDbToSave);
        updateSheetsFromFullDb_(backupDbToSave);
        notifyNewPayments_(backupCurrentDb, backupDbToSave);
      } else if (backupOnlyIfChanged) {
        return createJsonResponse({
          success: false,
          ok: false,
          message: 'لم تصل قاعدة بيانات صالحة لفحص النسخة التلقائية'
        });
      }

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


    // تقرير تحصيلات فترة إلى Telegram من داخل التطبيق — رسالة فقط للمراجعة.
    if (action === 'telegram_collection_report') {
      if (!isAuthorized_(params, data)) {
        return createJsonResponse({
          success: false,
          ok: false,
          message: 'رمز الحماية غير صحيح'
        });
      }

      return createJsonResponse(
        sendTelegramCollectionReport_(data)
      );
    }

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
      dbToSave.meta.schema = 12;

      writeCloudDb_(dbToSave);
      updateSheetsFromFullDb_(dbToSave);
      notifyNewPayments_(currentDb, dbToSave);

      // لو ميعاد النسخة اليومية عدى ولم تنجح بعد، أول مزامنة بعد رجوع الإنترنت تعيد المحاولة فورًا.
      try {
        sendTelegramDailyExcelJsonBackupIfDue_();
      } catch (dailyBackupError) {
        console.error('Daily JSON backup retry failed: ' + dailyBackupError.message);
      }

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
    '<p>الدوال المتاحة: pull_db / farm_full_db / telegram_backup / telegram_collection_report</p>' +
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
  db = canonicalizeCustomerAliasesServer_(db || {});
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
    return canonicalizeCustomerAliasesServer_(JSON.parse(text));
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
    'handovers',
    'audit_events'
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

  return canonicalizeCustomerAliasesServer_(merged);
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


function customerKeyServer_(name) {
  return normNameServer_(name).replace(/\s+/g, '');
}


function canonicalCustomerNameServer_(name) {
  var value = String(name || '').replace(/\s+/g, ' ').trim();
  return customerKeyServer_(value) === 'احمدربيعالعسكري'
    ? 'احمد ربيع العسكري'
    : value;
}


function canonicalizeCustomerAliasesServer_(db) {
  db = db || {};
  var sales = Array.isArray(db.sales) ? db.sales : [];
  var payments = Array.isArray(db.payments) ? db.payments : [];
  var salesById = {};

  sales.forEach(function (sale) {
    sale.name = canonicalCustomerNameServer_(sale.name);
    salesById[sale.id] = sale;
  });

  payments.forEach(function (payment) {
    var sale = salesById[payment.saleId];
    if (sale && sale.name) {
      payment.clientName = sale.name;
    } else if (customerKeyServer_(payment.clientName) === 'احمدربيعالعسكري') {
      payment.clientName = 'احمد ربيع العسكري';
    }
  });

  return db;
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


function isWarehouseReceiptServer_(receipt) {
  return !!(
    receipt &&
    receipt.warehouseFeedReceipt
  );
}


function isWarehouseUsageServer_(follow) {
  return !!(
    follow &&
    follow.warehouseFeedUsage
  );
}


function legacyFeedStatsServer_(
  cycleId,
  feedReceipts,
  follows
) {
  var receipts = (feedReceipts || [])
    .filter(function (receipt) {
      return receipt.cycleId === cycleId &&
        !isWarehouseReceiptServer_(receipt);
    })
    .slice()
    .sort(function (a, b) {
      return String(a.date || '')
        .localeCompare(String(b.date || '')) ||
        String(a.id || '')
          .localeCompare(String(b.id || ''));
    });

  var used = (follows || [])
    .filter(function (follow) {
      return follow.cycleId === cycleId &&
        !isWarehouseUsageServer_(follow);
    })
    .reduce(function (sum, follow) {
      return sum + Number(follow.feed_used || 0);
    }, 0);

  var left = used;
  var cost = 0;
  var lots = [];

  receipts.forEach(function (receipt) {
    var qty = Number(receipt.qty || 0);
    var price = Number(receipt.price || 0);
    var take = Math.min(left, qty);

    cost += take * price;
    left -= take;

    lots.push({
      id: receipt.id || '',
      date: receipt.date || '',
      qty: qty,
      price: price,
      used: take,
      remain: Math.max(0, qty - take),
      note: receipt.note || ''
    });
  });

  if (left > 0.009) {
    var lastPrice = receipts.length
      ? Number(receipts[receipts.length - 1].price || 0)
      : 0;
    cost += left * lastPrice;
  }

  return {
    consumed: used,
    cost: cost,
    shortage: Math.max(0, left),
    lots: lots
  };
}


function buildFeedWarehouseServer_(db) {
  db = db || {};

  var cycles = Array.isArray(db.cycles) ? db.cycles : [];
  var follows = Array.isArray(db.follows) ? db.follows : [];
  var receipts = Array.isArray(db.feed_receipts) ? db.feed_receipts : [];
  var cycleById = {};
  var cycleStats = {};
  var openingLots = [];

  cycles.forEach(function (cycle) {
    cycleById[cycle.id] = cycle;

    var legacy = legacyFeedStatsServer_(
      cycle.id,
      receipts,
      follows
    );

    cycleStats[cycle.id] = {
      legacyConsumed: legacy.consumed,
      warehouseConsumed: 0,
      consumed: legacy.consumed,
      legacyCost: legacy.cost,
      warehouseCost: 0,
      cost: legacy.cost
    };

    // المخزن العمومي يبدأ من صفر حسب اختيار المستخدم.
    // بواقي الاستلامات التاريخية لا تُرحّل، مع بقاء تكلفتها القديمة محفوظة للدورات.
  });

  var freshLots = receipts
    .filter(isWarehouseReceiptServer_)
    .map(function (receipt) {
      return {
        key: 'receipt:' + (receipt.id || ''),
        id: receipt.id || '',
        date: receipt.date || '',
        qty: Number(receipt.qty || 0),
        price: Number(receipt.price || 0),
        note: receipt.note || '',
        source: 'استلام جديد',
        opening: false
      };
    });

  var lots = openingLots
    .concat(freshLots)
    .sort(function (a, b) {
      return String(a.date || '')
        .localeCompare(String(b.date || '')) ||
        String(a.key || '')
          .localeCompare(String(b.key || ''));
    })
    .map(function (lot) {
      var out = Object.assign({}, lot);
      out.left = Number(lot.qty || 0);
      out.used = 0;
      out.usedCost = 0;
      return out;
    });

  var issues = follows
    .filter(function (follow) {
      return isWarehouseUsageServer_(follow) &&
        Number(follow.feed_used || 0) > 0;
    })
    .slice()
    .sort(function (a, b) {
      return String(a.date || '')
        .localeCompare(String(b.date || '')) ||
        String(a.id || '')
          .localeCompare(String(b.id || ''));
    });

  var lotIndex = 0;
  var shortage = 0;
  var issueRows = [];

  issues.forEach(function (follow) {
    var need = Number(follow.feed_used || 0);
    var cost = 0;

    while (
      need > 0.009 &&
      lotIndex < lots.length
    ) {
      var lot = lots[lotIndex];

      if (lot.left <= 0.009) {
        lotIndex++;
        continue;
      }

      var take = Math.min(need, lot.left);
      lot.left -= take;
      lot.used += take;
      lot.usedCost += take * lot.price;
      cost += take * lot.price;
      need -= take;
    }

    if (need > 0.009) {
      shortage += need;
    }

    if (!cycleStats[follow.cycleId]) {
      cycleStats[follow.cycleId] = {
        legacyConsumed: 0,
        warehouseConsumed: 0,
        consumed: 0,
        legacyCost: 0,
        warehouseCost: 0,
        cost: 0
      };
    }

    cycleStats[follow.cycleId].warehouseConsumed +=
      Number(follow.feed_used || 0);
    cycleStats[follow.cycleId].warehouseCost += cost;
    cycleStats[follow.cycleId].consumed +=
      Number(follow.feed_used || 0);
    cycleStats[follow.cycleId].cost += cost;

    issueRows.push({
      id: follow.id || '',
      date: follow.date || '',
      cycleNum:
        (cycleById[follow.cycleId] || {}).num || '-',
      qty: Number(follow.feed_used || 0),
      cost: cost,
      note: follow.notes || ''
    });
  });

  var totalReceived = lots.reduce(function (sum, lot) {
    return sum + Number(lot.qty || 0);
  }, 0);

  var totalUsed = issues.reduce(function (sum, issue) {
    return sum + Number(issue.feed_used || 0);
  }, 0);

  var remainValue = lots.reduce(function (sum, lot) {
    return sum +
      Number(lot.left || 0) *
      Number(lot.price || 0);
  }, 0);

  return {
    cycleStats: cycleStats,
    lots: lots,
    issues: issueRows,
    openingQty: openingLots.reduce(function (sum, lot) {
      return sum + Number(lot.qty || 0);
    }, 0),
    newReceived: freshLots.reduce(function (sum, lot) {
      return sum + Number(lot.qty || 0);
    }, 0),
    totalReceived: totalReceived,
    totalUsed: totalUsed,
    remain: Math.max(0, totalReceived - totalUsed),
    remainValue: remainValue,
    shortage: Math.max(0, shortage)
  };
}


function updateFeedWarehouseSheet_(db, warehouse) {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(
    FARM_FEED_WAREHOUSE_SHEET
  );

  if (!sheet) {
    sheet = spreadsheet.insertSheet(
      FARM_FEED_WAREHOUSE_SHEET
    );
  }

  prepareSheet_(sheet);
  sheet.setRightToLeft(true);

  sheet.getRange(1, 1, 1, 8)
    .setValues([[
      'مخزن العلف العمومي',
      '',
      '',
      '',
      '',
      '',
      '',
      ''
    ]])
    .setFontWeight('bold')
    .setBackground('#6b4f2a')
    .setFontColor('#ffffff');

  sheet.getRange(2, 1, 5, 2).setValues([
    ['رصيد افتتاحي قديم', warehouse.openingQty],
    ['استلامات جديدة', warehouse.newReceived],
    ['منصرف بعد التحديث', warehouse.totalUsed],
    ['الرصيد الحالي', warehouse.remain],
    ['قيمة الرصيد', warehouse.remainValue]
  ]);

  sheet.getRange(6, 2).setNumberFormat('0.## "جنيه"');

  var row = 8;
  sheet.getRange(row, 1, 1, 8).setValues([[
    'المصدر',
    'التاريخ',
    'الكمية',
    'سعر الشيكارة',
    'المستخدم',
    'المتبقي',
    'قيمة المتبقي',
    'ملاحظات'
  ]]).setFontWeight('bold').setBackground('#eadcc8');
  row++;

  var lotRows = warehouse.lots.map(function (lot) {
    return [
      lot.source || '',
      lot.date || '',
      Number(lot.qty || 0),
      Number(lot.price || 0),
      Number(lot.used || 0),
      Number(lot.left || 0),
      Number(lot.left || 0) * Number(lot.price || 0),
      lot.note || ''
    ];
  });

  if (lotRows.length) {
    sheet.getRange(row, 1, lotRows.length, 8)
      .setValues(lotRows);
    sheet.getRange(row, 4, lotRows.length, 1)
      .setNumberFormat('0.## "جنيه"');
    sheet.getRange(row, 7, lotRows.length, 1)
      .setNumberFormat('0.## "جنيه"');
    row += lotRows.length;
  }

  row += 2;
  sheet.getRange(row, 1, 1, 6).setValues([[
    'تاريخ الصرف',
    'الدورة',
    'الكمية',
    'التكلفة',
    'ملاحظات',
    'رقم الحركة'
  ]]).setFontWeight('bold').setBackground('#e6f5ec');
  row++;

  var issueRows = warehouse.issues.map(function (issue) {
    return [
      issue.date || '',
      '#' + issue.cycleNum,
      Number(issue.qty || 0),
      Number(issue.cost || 0),
      issue.note || '',
      issue.id || ''
    ];
  });

  if (issueRows.length) {
    sheet.getRange(row, 1, issueRows.length, 6)
      .setValues(issueRows);
    sheet.getRange(row, 4, issueRows.length, 1)
      .setNumberFormat('0.## "جنيه"');
  }

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 8);
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
      .setNumberFormat('0.## "جنيه"')
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
      .setNumberFormat('0.## "جنيه"')
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
  db = canonicalizeCustomerAliasesServer_(db || {});

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

  var feedWarehouse = buildFeedWarehouseServer_(db);
  updateFeedWarehouseSheet_(db, feedWarehouse);

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
      cycleFeedReceipts,
      feedWarehouse.cycleStats[cycle.id] || null
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
    var key = customerKeyServer_(
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
    .setNumberFormat('0.## "جنيه"')
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
  feedReceipts,
  feedStatsOverride
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
      '0.## "جنيه"'
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

  var feedStats = feedStatsOverride || feedStatsServer_(feedReceipts, follows);
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
      '0.## "جنيه"'
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

  sheet.getRange(wfRow, 3, 6, 1).setNumberFormat('0.## "جنيه"');
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
        '0.## "جنيه"'
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
        '0.## "جنيه"'
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
        '0.## "جنيه"'
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
        '0.## "جنيه"'
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
Telegram Payment Notifications
====================================
*/

function getNotifiedPaymentsSheet_(createIfMissing) {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(FARM_NOTIFIED_PAYMENTS_SHEET);

  if (!sheet && createIfMissing) {
    sheet = spreadsheet.insertSheet(FARM_NOTIFIED_PAYMENTS_SHEET);
    sheet.setRightToLeft(true);
    sheet
      .getRange(1, 1, 1, 4)
      .setValues([[
        'paymentId',
        'notifiedAt',
        'amount',
        'clientName'
      ]])
      .setFontWeight('bold');
    try {
      sheet.hideSheet();
    } catch (error) {}
  }

  return sheet;
}


function getNotifiedPaymentIds_() {
  var sheet = getNotifiedPaymentsSheet_(false);
  var ids = {};

  if (!sheet || sheet.getLastRow() < 2) {
    return ids;
  }

  var values = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 1)
    .getValues();

  values.forEach(function (row) {
    if (row[0]) {
      ids[String(row[0])] = true;
    }
  });

  return ids;
}


function markPaymentsNotified_(payments) {
  payments = Array.isArray(payments) ? payments : [];

  if (!payments.length) {
    return;
  }

  var sheet = getNotifiedPaymentsSheet_(true);
  var existing = getNotifiedPaymentIds_();
  var rows = [];
  var now = new Date();

  payments.forEach(function (payment) {
    if (!payment || !payment.id || existing[String(payment.id)]) {
      return;
    }

    rows.push([
      payment.id,
      now,
      Number(payment.amount || 0),
      payment.clientName || ''
    ]);

    existing[String(payment.id)] = true;
  });

  if (rows.length) {
    sheet
      .getRange(sheet.getLastRow() + 1, 1, rows.length, 4)
      .setValues(rows);
    sheet
      .getRange(2, 2, Math.max(sheet.getLastRow() - 1, 1), 1)
      .setNumberFormat('dd/MM/yyyy HH:mm:ss');
  }

  try {
    sheet.hideSheet();
  } catch (error) {}
}


function arabicDayName_(date) {
  var days = [
    'الأحد',
    'الاثنين',
    'الثلاثاء',
    'الأربعاء',
    'الخميس',
    'الجمعة',
    'السبت'
  ];

  return days[date.getDay()] || '';
}


function paymentDateInfo_(value) {
  var date = value ? new Date(value) : new Date();

  if (isNaN(date.getTime())) {
    date = new Date();
  }

  return {
    date: date,
    day: arabicDayName_(date),
    dateText: Utilities.formatDate(date, FARM_TIMEZONE, 'dd/MM/yyyy'),
    timeText: Utilities.formatDate(date, FARM_TIMEZONE, 'HH:mm')
  };
}


function buildPaymentIndexes_(db) {
  db = db || {};

  var cyclesById = {};
  var salesById = {};
  var paymentsBySale = {};

  (Array.isArray(db.cycles) ? db.cycles : []).forEach(function (cycle) {
    cyclesById[cycle.id] = cycle;
  });

  (Array.isArray(db.sales) ? db.sales : []).forEach(function (sale) {
    salesById[sale.id] = sale;
  });

  (Array.isArray(db.payments) ? db.payments : []).forEach(function (payment) {
    if (!paymentsBySale[payment.saleId]) {
      paymentsBySale[payment.saleId] = [];
    }
    paymentsBySale[payment.saleId].push(payment);
  });

  return {
    cyclesById: cyclesById,
    salesById: salesById,
    paymentsBySale: paymentsBySale
  };
}


function saleRemainingAfterPayment_(sale, paymentsBySale) {
  if (!sale || !sale.id) {
    return null;
  }

  var total = saleTotalFromDb_(sale);
  var paid = (paymentsBySale[sale.id] || [])
    .reduce(function (sum, payment) {
      return sum + Number(payment.amount || 0);
    }, 0);
  var waived = Number(sale.waived || 0);

  return Math.max(0, total - paid - waived);
}


function paymentKindText_(payment) {
  if (payment.batchId) {
    return 'دفعة مجمعة';
  }

  if (/كاش/.test(String(payment.note || ''))) {
    return 'كاش مع البيع';
  }

  return 'سداد';
}


function normalizeCollectorServer_(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/^ال/, '')
    .replace(/\s+/g, ' ');
}


function collectorLabel_(collector) {
  var raw = String(collector || '').trim();
  var normalized = normalizeCollectorServer_(raw);

  if (!raw) {
    return '⚪ غير محدد';
  }

  if (
    normalized.indexOf('مهني') !== -1 ||
    normalized.indexOf('محترف') !== -1
  ) {
    return '🟠 ' + raw;
  }

  if (
    normalized.indexOf('اسلام') !== -1 ||
    normalized.indexOf('eslam') !== -1 ||
    normalized.indexOf('islam') !== -1
  ) {
    return '🟢 ' + raw;
  }

  return '🔵 ' + raw;
}


function buildSinglePaymentTelegramMessage_(payment, db, indexes) {
  var sale = indexes.salesById[payment.saleId] || {};
  var cycle = indexes.cyclesById[sale.cycleId] || {};
  var info = paymentDateInfo_(payment.date || payment.createdAt);
  var remain = saleRemainingAfterPayment_(sale, indexes.paymentsBySale);

  var collectorText = collectorLabel_(payment.collector);

  var lines = [
    '💰 تحصيل جديد — ' + collectorText,
    '',
    'اليوم: ' + info.day,
    'التاريخ: ' + info.dateText,
    'الوقت: ' + info.timeText,
    '',
    'العميل / التاجر: ' + (payment.clientName || sale.name || '-'),
    cycle.num ? ('الدورة: #' + cycle.num) : 'الدورة: -',
    sale.clientType ? ('نوع العميل: ' + sale.clientType) : '',
    'المبلغ: ' + formatMoney_(payment.amount) + ' جنيه',
    'المحصل: ' + collectorText,
    'نوع التحصيل: ' + paymentKindText_(payment),
    payment.note ? ('ملاحظة: ' + payment.note) : '',
    remain !== null ? ('المتبقي على البيعة: ' + formatMoney_(remain) + ' جنيه') : ''
  ];

  return lines
    .filter(function (line) {
      return line !== '';
    })
    .join('\n');
}


function buildBatchPaymentTelegramMessage_(payments, db, indexes) {
  payments = payments || [];

  var first = payments[0] || {};
  var info = paymentDateInfo_(first.date || first.createdAt);
  var total = payments.reduce(function (sum, payment) {
    return sum + Number(payment.amount || 0);
  }, 0);

  var cycles = {};
  payments.forEach(function (payment) {
    var sale = indexes.salesById[payment.saleId] || {};
    var cycle = indexes.cyclesById[sale.cycleId] || {};
    if (cycle.num) {
      cycles['#' + cycle.num] = true;
    }
  });

  var cycleText = Object.keys(cycles).join('، ') || '-';

  var collectorText = collectorLabel_(first.collector);

  var breakdown = payments.map(function (payment) {
    var sale = indexes.salesById[payment.saleId] || {};
    var cycle = indexes.cyclesById[sale.cycleId] || {};
    return '- ' +
      (cycle.num ? ('#' + cycle.num + ': ') : '') +
      formatMoney_(payment.amount) +
      ' جنيه';
  }).join('\n');

  return [
    '💰 تحصيل جديد — دفعة مجمعة — ' + collectorText,
    '',
    'اليوم: ' + info.day,
    'التاريخ: ' + info.dateText,
    'الوقت: ' + info.timeText,
    '',
    'العميل / التاجر: ' + (first.clientName || '-'),
    'الدورات: ' + cycleText,
    'إجمالي المبلغ: ' + formatMoney_(total) + ' جنيه',
    'المحصل: ' + collectorText,
    '',
    'توزيع الدفعة:',
    breakdown
  ].join('\n');
}


function groupNewPaymentsForNotifications_(payments) {
  var groups = {};

  payments.forEach(function (payment) {
    var key = payment.batchId
      ? ('batch:' + payment.batchId)
      : ('payment:' + payment.id);

    if (!groups[key]) {
      groups[key] = [];
    }

    groups[key].push(payment);
  });

  return Object.keys(groups).map(function (key) {
    return groups[key];
  });
}


function notifyNewPayments_(previousDb, newDb) {
  if (!FARM_TELEGRAM_NOTIFY_PAYMENTS) {
    return;
  }

  newDb = newDb || {};
  previousDb = previousDb || null;

  var allPayments = Array.isArray(newDb.payments)
    ? newDb.payments
    : [];

  if (!allPayments.length) {
    return;
  }

  var previousIds = {};
  if (previousDb && Array.isArray(previousDb.payments)) {
    previousDb.payments.forEach(function (payment) {
      if (payment && payment.id) {
        previousIds[String(payment.id)] = true;
      }
    });
  }

  var notifiedSheet = getNotifiedPaymentsSheet_(false);
  var notifiedIds = getNotifiedPaymentIds_();

  // أول مرة بعد تفعيل الميزة: علّم المدفوعات القديمة كأنها اتبعتت،
  // وابعت إشعار فقط للمدفوعات الجديدة مقارنة بالنسخة السابقة في السحابة.
  if (!notifiedSheet) {
    var oldPayments = previousDb && Array.isArray(previousDb.payments)
      ? previousDb.payments
      : allPayments;
    markPaymentsNotified_(oldPayments);
    notifiedIds = getNotifiedPaymentIds_();
  }

  var newPayments = allPayments.filter(function (payment) {
    if (!payment || !payment.id) {
      return false;
    }

    if (Number(payment.amount || 0) <= 0) {
      return false;
    }

    if (notifiedIds[String(payment.id)]) {
      return false;
    }

    // لو فيه نسخة سابقة، ابعت فقط اللي مش موجود فيها.
    if (previousDb && previousIds[String(payment.id)]) {
      return false;
    }

    return true;
  });

  if (!newPayments.length) {
    return;
  }

  var indexes = buildPaymentIndexes_(newDb);
  var groups = groupNewPaymentsForNotifications_(newPayments);
  var successfullySent = [];

  groups.forEach(function (group) {
    try {
      var message = group.length > 1 || group[0].batchId
        ? buildBatchPaymentTelegramMessage_(group, newDb, indexes)
        : buildSinglePaymentTelegramMessage_(group[0], newDb, indexes);

      sendTelegramMessage_(message);

      group.forEach(function (payment) {
        successfullySent.push(payment);
      });

      Utilities.sleep(250);

    } catch (error) {
      console.error('Payment telegram notification failed: ' + error.message);
    }
  });

  markPaymentsNotified_(successfullySent);
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


function normalizeReportDateKey_(value) {
  value = String(value || '').trim();

  var direct = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) {
    return direct[1] + '-' + direct[2] + '-' + direct[3];
  }

  var date = new Date(value);
  if (isNaN(date.getTime())) {
    return '';
  }

  return Utilities.formatDate(
    date,
    FARM_TIMEZONE,
    'yyyy-MM-dd'
  );
}


function reportDateText_(dateKey) {
  dateKey = normalizeReportDateKey_(dateKey);

  if (!dateKey) {
    return '-';
  }

  return dateKey.slice(8, 10) +
    '/' +
    dateKey.slice(5, 7) +
    '/' +
    dateKey.slice(0, 4);
}


function isProCollectorServer_(collector) {
  var normalized = normalizeCollectorServer_(collector);

  return !!normalized &&
    (
      normalized.indexOf('مهني') !== -1 ||
      normalized.indexOf('محترف') !== -1
    );
}


function collectionReportCollectorText_(collector) {
  collector = String(collector || '__pro__').trim();

  if (collector === '__all__') {
    return 'كل المحصلين';
  }

  if (collector === '__pro__') {
    return '🟠 المهني / محترف';
  }

  if (collector === '__empty__') {
    return '⚪ غير محدد';
  }

  return collectorLabel_(collector);
}


function paymentMatchesCollectionReportCollector_(payment, collector) {
  collector = String(collector || '__pro__').trim();
  payment = payment || {};

  if (collector === '__all__') {
    return true;
  }

  if (collector === '__empty__') {
    return !String(payment.collector || '').trim();
  }

  if (collector === '__pro__') {
    return isProCollectorServer_(payment.collector);
  }

  return normalizeCollectorServer_(payment.collector) ===
    normalizeCollectorServer_(collector);
}


function getDbForCollectionReport_(data) {
  data = data || {};

  var cloudDb = readCloudDb_();
  var incomingDb = data.db || null;

  var incomingValid = incomingDb &&
    Array.isArray(incomingDb.sales) &&
    Array.isArray(incomingDb.payments);

  if (cloudDb && incomingValid) {
    return mergeDbsServer_(cloudDb, incomingDb);
  }

  if (incomingValid) {
    return incomingDb;
  }

  if (cloudDb) {
    return cloudDb;
  }

  return {
    cycles: [],
    sales: [],
    payments: [],
    follows: [],
    feed_receipts: [],
    expenses: [],
    handovers: [],
    meta: {}
  };
}


function groupCollectionReportPayments_(payments) {
  var groups = {};
  var order = [];

  (payments || []).forEach(function (payment) {
    var key = payment.batchId
      ? ('batch:' + payment.batchId)
      : ('payment:' + (payment.id || Math.random()));

    if (!groups[key]) {
      groups[key] = {
        key: key,
        payments: [],
        total: 0,
        date: payment.date || payment.createdAt || ''
      };
      order.push(key);
    }

    groups[key].payments.push(payment);
    groups[key].total += Number(payment.amount || 0);

    var paymentDate = String(payment.date || payment.createdAt || '');
    if (
      paymentDate &&
      (
        !groups[key].date ||
        paymentDate < String(groups[key].date || '')
      )
    ) {
      groups[key].date = paymentDate;
    }
  });

  return order
    .map(function (key) {
      return groups[key];
    })
    .sort(function (a, b) {
      return String(a.date || '')
        .localeCompare(
          String(b.date || '')
        );
    });
}


function buildCollectionReportItemText_(group, index, indexes) {
  group = group || {};
  var payments = group.payments || [];
  var first = payments[0] || {};
  var info = paymentDateInfo_(first.date || first.createdAt || group.date);
  var cycles = {};
  var breakdown = [];

  payments.forEach(function (payment) {
    var sale = indexes.salesById[payment.saleId] || {};
    var cycle = indexes.cyclesById[sale.cycleId] || {};

    if (cycle.num) {
      cycles['#' + cycle.num] = true;
      breakdown.push(
        '#' +
        cycle.num +
        ': ' +
        formatMoney_(payment.amount) +
        ' جنيه'
      );
    } else {
      breakdown.push(
        formatMoney_(payment.amount) +
        ' جنيه'
      );
    }
  });

  var cycleText = Object.keys(cycles).join('، ') || '-';
  var kind = first.batchId ? 'تحصيل مجمع' : paymentKindText_(first);
  var note = String(first.note || '').trim();

  var lines = [
    index + ') ' + (first.clientName || (indexes.salesById[first.saleId] || {}).name || '-'),
    'المبلغ: ' + formatMoney_(group.total) + ' جنيه',
    'التاريخ: ' + info.dateText + ' — الوقت: ' + info.timeText,
    payments.length > 1 ? ('الدورات: ' + cycleText) : ('الدورة: ' + cycleText),
    'نوع التحصيل: ' + kind,
    payments.length > 1 ? ('التوزيع: ' + breakdown.join(' ← ')) : '',
    note ? ('ملاحظة: ' + note) : ''
  ];

  return lines
    .filter(function (line) {
      return line !== '';
    })
    .join('\n');
}


function buildCollectionReportMessages_(db, options) {
  db = db || {};
  options = options || {};

  var fromDate = normalizeReportDateKey_(options.fromDate);
  var toDate = normalizeReportDateKey_(options.toDate);
  var collector = String(options.collector || '__pro__').trim();

  if (!fromDate || !toDate) {
    throw new Error('اختار تاريخ بداية ونهاية صحيحين');
  }

  if (fromDate > toDate) {
    throw new Error('تاريخ البداية أكبر من تاريخ النهاية');
  }

  var payments = (Array.isArray(db.payments) ? db.payments : [])
    .filter(function (payment) {
      var dateKey = normalizeReportDateKey_(
        payment.date ||
        payment.createdAt
      );

      return Number(payment.amount || 0) > 0 &&
        dateKey >= fromDate &&
        dateKey <= toDate &&
        paymentMatchesCollectionReportCollector_(payment, collector);
    });

  var groups = groupCollectionReportPayments_(payments);
  var total = payments.reduce(function (sum, payment) {
    return sum + Number(payment.amount || 0);
  }, 0);

  var now = Utilities.formatDate(
    new Date(),
    FARM_TIMEZONE,
    'dd/MM/yyyy HH:mm'
  );

  var summaryLines = [
    '📒 تقرير تحصيلات فترة',
    '',
    'الفترة: من ' + reportDateText_(fromDate) + ' إلى ' + reportDateText_(toDate),
    'المحصل: ' + collectionReportCollectorText_(collector),
    '',
    'عدد العمليات: ' + groups.length,
    'إجمالي التحصيل: ' + formatMoney_(total) + ' جنيه',
    'وقت التقرير: ' + now
  ];

  var summary = summaryLines.join('\n');

  if (!groups.length) {
    return [
      summary +
      '\n\nلا توجد عمليات تحصيل في هذه الفترة.'
    ];
  }

  var indexes = buildPaymentIndexes_(db);
  var itemTexts = groups.map(function (group, index) {
    return buildCollectionReportItemText_(
      group,
      index + 1,
      indexes
    );
  });

  var chunks = [];
  var current = '';
  var limit = 3000;

  itemTexts.forEach(function (itemText) {
    var next = current
      ? (current + '\n\n' + itemText)
      : itemText;

    if (
      next.length > limit &&
      current
    ) {
      chunks.push(current);
      current = itemText;
    } else {
      current = next;
    }
  });

  if (current) {
    chunks.push(current);
  }

  var totalParts = chunks.length;

  return chunks.map(function (chunk, index) {
    return summary +
      (totalParts > 1
        ? ('\nالجزء: ' + (index + 1) + ' من ' + totalParts)
        : '') +
      '\n\nتفاصيل العمليات:\n\n' +
      chunk;
  });
}


function sendTelegramCollectionReport_(data) {
  try {
    data = data || {};

    var db = getDbForCollectionReport_(data);
    var messages = buildCollectionReportMessages_(
      db,
      {
        fromDate: data.fromDate,
        toDate: data.toDate,
        collector: data.collector
      }
    );

    messages.forEach(function (message, index) {
      sendTelegramMessage_(message);

      if (index < messages.length - 1) {
        Utilities.sleep(400);
      }
    });

    return {
      success: true,
      ok: true,
      sent: true,
      parts: messages.length,
      message: 'تم إرسال تقرير التحصيلات إلى Telegram'
    };

  } catch (error) {
    console.error(error);

    return {
      success: false,
      ok: false,
      sent: false,
      message: error.message
    };
  }
}


function testCollectionReportTodayMessage() {
  var today = Utilities.formatDate(
    new Date(),
    FARM_TIMEZONE,
    'yyyy-MM-dd'
  );

  var messages = buildCollectionReportMessages_(
    readCloudDb_() || {},
    {
      fromDate: today,
      toDate: today,
      collector: '__pro__'
    }
  );

  Logger.log(
    messages.join('\n\n----------------\n\n')
  );

  return messages[0];
}


function formatMoney_(value) {
  var n = Number(value || 0);
  if (!isFinite(n)) {
    n = 0;
  }
  n = Math.round((n + Number.EPSILON) * 100) / 100;
  return String(n).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}


function testAccountingTotalsNow() {
  var db = readCloudDb_() || {};
  var sales = Array.isArray(db.sales) ? db.sales : [];
  var payments = Array.isArray(db.payments) ? db.payments : [];
  var debts = buildCustomerDebtsFromDb_(db);

  var totalSales = sales.reduce(function (sum, sale) {
    return sum + saleTotalFromDb_(sale);
  }, 0);

  var totalPaid = payments.reduce(function (sum, payment) {
    return sum + Number(payment.amount || 0);
  }, 0);

  var totalWaived = sales.reduce(function (sum, sale) {
    return sum + Number(sale.waived || 0);
  }, 0);

  var totalDebt = debts.reduce(function (sum, item) {
    return sum + Number(item.remain || 0);
  }, 0);

  var difference =
    totalSales -
    totalPaid -
    totalWaived -
    totalDebt;

  var result = {
    totalSales: Number(formatMoney_(totalSales)),
    totalPaid: Number(formatMoney_(totalPaid)),
    totalWaived: Number(formatMoney_(totalWaived)),
    totalDebt: Number(formatMoney_(totalDebt)),
    difference: Number(formatMoney_(difference)),
    balanced: Math.abs(difference) < 0.01,
    salesCount: sales.length,
    paymentsCount: payments.length,
    customerGroupsCount: debts.length
  };

  Logger.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );

  return result;
}


function getFarmSummary_() {
  // المصدر الأدق للملخص هو قاعدة بيانات التطبيق الكاملة في شيت المزامنة المخفي.
  // السبب: شيت "ديون العملاء" يحتوي صف إجمالي في آخره، ولو الملخص قرأه كعميل عادي الأرقام بتتضاعف أو تكبر.
  var db = readCloudDb_();

  if (db && Array.isArray(db.sales)) {
    var sales = Array.isArray(db.sales) ? db.sales : [];
    var payments = Array.isArray(db.payments) ? db.payments : [];
    var cycles = Array.isArray(db.cycles) ? db.cycles : [];
    var debts = buildCustomerDebtsFromDb_(db);

    var totalSales = sales.reduce(function (sum, sale) {
      return sum + saleTotalFromDb_(sale);
    }, 0);

    var totalPaid = payments.reduce(function (sum, payment) {
      return sum + Number(payment.amount || 0);
    }, 0);

    var totalDebt = debts.reduce(function (sum, item) {
      return sum + Number(item.remain || 0);
    }, 0);

    var debtorCount = debts.filter(function (item) {
      return Number(item.remain || 0) > 0.009;
    }).length;

    return {
      totalSales: totalSales,
      totalPaid: totalPaid,
      totalDebt: totalDebt,
      debtorCount: debtorCount,
      cycleCount: cycles.length,
      source: 'cloud_db'
    };
  }

  // fallback قديم لو مفيش نسخة كاملة لسه: اقرأ شيت الديون لكن تجاهل صف الإجمالي.
  var spreadsheet = getSpreadsheet_();
  var debtsSheet = spreadsheet.getSheetByName('ديون العملاء');

  var totalSalesFallback = 0;
  var totalPaidFallback = 0;
  var totalDebtFallback = 0;
  var debtorCountFallback = 0;

  if (debtsSheet && debtsSheet.getLastRow() >= 2) {
    var lastRow = debtsSheet.getLastRow();
    var values = debtsSheet
      .getRange(2, 1, lastRow - 1, 7)
      .getValues();

    values.forEach(function (row) {
      var label = String(row[0] || '').trim();
      var name = String(row[1] || '').trim();

      // تجاهل صف الإجمالي وأي صف فارغ أو رسائل نصية.
      if (
        label === 'الإجمالي' ||
        name === 'الإجمالي' ||
        !name ||
        name === 'لا توجد ديون مستحقة على العملاء'
      ) {
        return;
      }

      var salesValue = Number(row[4]) || 0;
      var paidValue = Number(row[5]) || 0;
      var debtValue = Number(row[6]) || 0;

      totalSalesFallback += salesValue;
      totalPaidFallback += paidValue;
      totalDebtFallback += debtValue;

      if (debtValue > 0.009) {
        debtorCountFallback++;
      }
    });
  }

  var cycleCountFallback = spreadsheet
    .getSheets()
    .filter(function (sheet) {
      return /^الدورة #/.test(sheet.getName());
    })
    .length;

  return {
    totalSales: totalSalesFallback,
    totalPaid: totalPaidFallback,
    totalDebt: totalDebtFallback,
    debtorCount: debtorCountFallback,
    cycleCount: cycleCountFallback,
    source: 'sheet_fallback'
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


function testFarmSummaryNow() {
  var summary = getFarmSummary_();

  return [
    'مصدر الملخص: ' + summary.source,
    'إجمالي المبيعات: ' + formatMoney_(summary.totalSales),
    'إجمالي المحصل: ' + formatMoney_(summary.totalPaid),
    'ديون العملاء: ' + formatMoney_(summary.totalDebt),
    'عدد العملاء المدينين: ' + summary.debtorCount,
    'عدد الدورات: ' + summary.cycleCount
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


function createJsonBlob_(backupDate) {
  var spreadsheet = getSpreadsheet_();
  var cloudDb = readCloudDb_() || {
    cycles: [],
    follows: [],
    sales: [],
    payments: [],
    feed_receipts: [],
    expenses: [],
    handovers: [],
    audit_events: [],
    settings: {},
    meta: {}
  };

  // نخلي قاعدة التطبيق نفسها في الجذر حتى يمكن استيراد الملف مباشرة داخل التطبيق.
  var backup = cloneServer_(cloudDb);
  syncCollectionsServer_().forEach(function (key) {
    if (!Array.isArray(backup[key])) {
      backup[key] = [];
    }
  });
  backup.settings = backup.settings || {};
  backup.meta = backup.meta || {};
  backup._backup = {
    format: 'farm-complete-json-backup-v10.24',
    version: '10.24',
    createdAt: new Date().toISOString(),
    backupDate: backupDate || localDateKeyServer_(new Date()),
    timezone: FARM_TIMEZONE,
    spreadsheetName: spreadsheet.getName(),
    spreadsheetId: spreadsheet.getId(),
    includesApplicationDatabase: true,
    includesAllSheets: true,
    directlyImportableToApp: true
  };
  backup._sheets = [];

  spreadsheet.getSheets().forEach(function (sheet) {
    var rows = sheet.getLastRow();
    var columns = sheet.getLastColumn();
    var values = [];
    var formulas = [];

    if (rows > 0 && columns > 0) {
      var range = sheet.getRange(1, 1, rows, columns);
      values = range.getDisplayValues();
      formulas = range.getFormulas();
    }

    backup._sheets.push({
      name: sheet.getName(),
      hidden: sheet.isSheetHidden(),
      rows: rows,
      columns: columns,
      values: values,
      formulas: formulas
    });
  });

  var stamp = Utilities.formatDate(
    new Date(),
    FARM_TIMEZONE,
    'yyyy-MM-dd_HH-mm'
  );

  return Utilities.newBlob(
    JSON.stringify(backup, null, 2),
    'application/json',
    'نسخة-المزرعة-كاملة-' + stamp + '.json'
  );
}


function markJsonBackupSuccess_(backupDate) {
  var properties = PropertiesService.getScriptProperties();
  var cloudDb = readCloudDb_() || {};
  var dataUpdatedAt =
    (cloudDb.meta && cloudDb.meta.updatedAt) ||
    new Date().toISOString();

  properties.setProperty(
    FARM_DAILY_JSON_BACKUP_PROPERTY,
    backupDate || localDateKeyServer_(new Date())
  );
  properties.setProperty(
    FARM_LAST_JSON_BACKUP_DATA_UPDATED_AT_PROPERTY,
    dataUpdatedAt
  );
}


function sendTelegramFullBackup() {
  try {
    var now = Utilities.formatDate(
      new Date(),
      FARM_TIMEZONE,
      'dd/MM/yyyy hh:mm a'
    );
    var today = localDateKeyServer_(new Date());

    sendTelegramMessage_(
      buildFarmSummaryMessage_() +
      '\n\nسيتم إرسال ملف Excel كامل وملف JSON كامل قابل للاستيراد.'
    );

    Utilities.sleep(500);

    sendTelegramDocument_(
      createExcelBlob_(),
      'نسخة Excel كاملة لكل شيتات المزرعة\n' +
      now
    );

    Utilities.sleep(500);

    sendTelegramDocument_(
      createJsonBlob_(today),
      'نسخة JSON كاملة لكل بيانات المزرعة وقابلة للاستيراد\n' +
      now
    );

    markJsonBackupSuccess_(today);

    return {
      success: true,
      ok: true,
      format: 'xlsx+json',
      message: 'تم إرسال الملخص وملفي Excel وJSON الكاملين إلى Telegram'
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


function localDateKeyServer_(date) {
  return Utilities.formatDate(
    date || new Date(),
    FARM_TIMEZONE,
    'yyyy-MM-dd'
  );
}


function previousLocalDateKeyServer_(date) {
  var previous = new Date((date || new Date()).getTime() - 24 * 60 * 60 * 1000);
  return localDateKeyServer_(previous);
}


function localHourServer_(date) {
  return Number(
    Utilities.formatDate(
      date || new Date(),
      FARM_TIMEZONE,
      'H'
    )
  );
}


function dailyJsonBackupTargetDate_(now, lastSentDate) {
  var today = localDateKeyServer_(now);
  var hour = localHourServer_(now);

  if (hour >= FARM_DAILY_JSON_BACKUP_HOUR) {
    return today;
  }

  // لو اتبعتت نسخة يدوية اليوم، تعتبر نسخة اليوم ولا نرجع نبعت نسخة أمس.
  if (lastSentDate === today) {
    return '';
  }

  return previousLocalDateKeyServer_(now);
}


function sendTelegramDailyExcelJsonBackupIfDue_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    return {
      success: true,
      ok: true,
      skipped: true,
      message: 'يوجد فحص نسخة يومية آخر قيد التنفيذ'
    };
  }

  try {
    var properties = PropertiesService.getScriptProperties();
    var lastSentDate = properties.getProperty(
      FARM_DAILY_JSON_BACKUP_PROPERTY
    ) || '';
    var now = new Date();
    var targetDate = dailyJsonBackupTargetDate_(now, lastSentDate);

    if (!targetDate || lastSentDate === targetDate) {
      return {
        success: true,
        ok: true,
        skipped: true,
        lastSentDate: lastSentDate,
        message: 'النسخة اليومية أُرسلت بالفعل'
      };
    }

    var sentAtText = Utilities.formatDate(
      now,
      FARM_TIMEZONE,
      'dd/MM/yyyy hh:mm a'
    );

    sendTelegramDocument_(
      createExcelBlob_(),
      [
        'نسخة Excel اليومية الكاملة للمزرعة',
        'يوم النسخة: ' + targetDate,
        'تم الإرسال: ' + sentAtText
      ].join('\n')
    );

    Utilities.sleep(500);

    sendTelegramDocument_(
      createJsonBlob_(targetDate),
      [
        'نسخة JSON اليومية الكاملة والقابلة للاستيراد',
        'يوم النسخة: ' + targetDate,
        'تم الإرسال: ' + sentAtText
      ].join('\n')
    );

    // لا نسجل اليوم إلا بعد نجاح إرسال الملفين؛ لو فشل أحدهما يعيد التريجر المحاولة.
    markJsonBackupSuccess_(targetDate);

    return {
      success: true,
      ok: true,
      sent: true,
      backupDate: targetDate,
      message: 'تم إرسال نسختي Excel وJSON اليوميتين'
    };
  } finally {
    lock.releaseLock();
  }
}


function sendTelegramDailyExcelJsonBackup() {
  var result = sendTelegramDailyExcelJsonBackupIfDue_();
  if (!result.success) {
    throw new Error(result.message || 'فشل إرسال النسخة اليومية');
  }
  return result;
}


function sendTelegramDailyExcelJsonBackupNow() {
  var now = new Date();
  var today = localDateKeyServer_(now);

  var nowText = Utilities.formatDate(
    now,
    FARM_TIMEZONE,
    'dd/MM/yyyy hh:mm a'
  );

  sendTelegramDocument_(
    createExcelBlob_(),
    'نسخة Excel كاملة فورية للمزرعة\n' + nowText
  );

  Utilities.sleep(500);

  sendTelegramDocument_(
    createJsonBlob_(today),
    'نسخة JSON كاملة فورية وقابلة للاستيراد\n' + nowText
  );

  markJsonBackupSuccess_(today);

  return {
    success: true,
    ok: true,
    sent: true,
    backupDate: today
  };
}


// أسماء توافقية للنسخة السابقة؛ كلاهما يرسل Excel وJSON في v10.24.
function sendTelegramDailyJsonBackup() {
  return sendTelegramDailyExcelJsonBackup();
}

function sendTelegramDailyJsonBackupNow() {
  return sendTelegramDailyExcelJsonBackupNow();
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

  // فحص كل ساعة: يرسل مرة واحدة فقط يوميًا، ويكرر المحاولة لو Telegram أو الإنترنت لم يكونا متاحين.
  ScriptApp
    .newTrigger('sendTelegramDailyExcelJsonBackup')
    .timeBased()
    .everyHours(1)
    .create();

  // إرسال أول نسخة فور تشغيل الإعدادات بدل انتظار الساعة 11 مساءً.
  var firstBackup = sendTelegramDailyExcelJsonBackupNow();

  sendTelegramMessage_(
    [
      'تم تشغيل نسختي Excel وJSON الكاملتين تلقائيًا للمزرعة.',
      '',
      'تم إرسال أول نسخة الآن: ' + firstBackup.backupDate,
      'النسخة اليومية الأساسية: الساعة 11 مساءً بتوقيت القاهرة.',
      'لو فشل الإرسال، تتم إعادة المحاولة كل ساعة.',
      'وأول مزامنة بعد عودة الإنترنت تحاول الإرسال فورًا.',
      'يتم إرسال ملف Excel لكل الشيتات وملف JSON لقاعدة التطبيق وكل صفحات Google Sheets.'
    ].join('\n')
  );

  return firstBackup;
}


function deleteTelegramTriggers_() {
  var handlerNames = [
    'sendTelegramDailySummary',
    'sendTelegramWeeklyBackup',
    'sendTelegramDailyExcelJsonBackup',
    'sendTelegramDailyJsonBackup'
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
