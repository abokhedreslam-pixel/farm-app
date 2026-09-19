/*
  إدارة المزرعة — Google Apps Script للمزامنة بين الأجهزة
  1) افتح https://script.google.com وأنشئ مشروع جديد.
  2) الصق الكود ده كله.
  3) Deploy > New deployment > Web app
     Execute as: Me
     Who has access: Anyone
  4) انسخ رابط /exec وحطه في إعدادات تطبيق المزرعة.

  اختياري: اكتب رمز حماية بين علامتي التنصيص في FARM_SYNC_TOKEN،
  واكتب نفس الرمز في التطبيق.
*/

var FARM_SYNC_TOKEN = ''; // مثال: '12345' — سيبها فاضية لو مش عايز رمز حماية
var FARM_SYNC_FOLDER = 'FarmAppSync';
var FARM_SYNC_FILE = 'farm_app_db.json';

function doGet(e) {
  var p = (e && e.parameter) || {};
  var callback = p.callback || '';
  var action = p.action || '';

  if (!isAuthorized_(p, null)) {
    return output_(callback, { ok: false, error: 'رمز الحماية غير صحيح' });
  }

  if (action === 'pull_db') {
    var db = readDb_();
    if (!db) return output_(callback, { ok: true, empty: true });
    return output_(callback, {
      ok: true,
      empty: false,
      updatedAt: (db.meta && db.meta.updatedAt) || '',
      deviceId: (db.meta && db.meta.deviceId) || '',
      db: db
    });
  }

  return output_(callback, { ok: true, message: 'Farm sync script is running' });
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  var dataText = p.data || (e && e.postData && e.postData.contents) || '';
  var data = {};
  if (dataText) {
    try { data = JSON.parse(dataText); } catch (err) { data = {}; }
  }
  var action = p.action || data.action || '';

  if (!isAuthorized_(p, data)) {
    return output_('', { ok: false, error: 'رمز الحماية غير صحيح' });
  }

  if (action === 'farm_full_db') {
    var incoming = data.db || data;
    if (typeof incoming === 'string') incoming = JSON.parse(incoming);
    if (!incoming || !incoming.cycles || !incoming.sales) {
      return output_('', { ok: false, error: 'قاعدة البيانات غير صالحة' });
    }

    var current = readDb_();
    var incomingTime = time_((incoming.meta && incoming.meta.updatedAt) || data.updatedAt);
    var currentTime = current ? time_((current.meta && current.meta.updatedAt) || '') : 0;

    // لو النسخة اللي وصلت أحدث أو مفيش نسخة محفوظة، خزّنها.
    if (!current || incomingTime >= currentTime) {
      writeDb_(incoming);
      return output_('', { ok: true, saved: true, updatedAt: (incoming.meta && incoming.meta.updatedAt) || '' });
    }

    return output_('', { ok: true, saved: false, ignoredOlder: true, cloudUpdatedAt: (current.meta && current.meta.updatedAt) || '' });
  }

  if (action === 'log_customer_payment') {
    // اختياري: بنحفظ آخر سداد في ملف بسيط للمراجعة، والمزامنة الأساسية بتتم من قاعدة البيانات الكاملة.
    return output_('', { ok: true, logged: true });
  }

  if (action === 'telegram_backup') {
    // مكان مخصص لو عندك كود تيليجرام قديم وعايز تضيفه هنا.
    return output_('', { ok: true, message: 'Telegram action received. Add your Telegram code here if needed.' });
  }

  return output_('', { ok: true, message: 'No action' });
}

function isAuthorized_(p, data) {
  var required = String(FARM_SYNC_TOKEN || '').trim();
  if (!required) return true;
  var got = String((p && (p.token || p.syncToken)) || (data && data.syncToken) || '').trim();
  return got === required;
}

function time_(v) {
  var t = Date.parse(v || '1970-01-01T00:00:00.000Z');
  return isNaN(t) ? 0 : t;
}

function getFolder_() {
  var folders = DriveApp.getFoldersByName(FARM_SYNC_FOLDER);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(FARM_SYNC_FOLDER);
}

function getFile_(createIfMissing) {
  var folder = getFolder_();
  var files = folder.getFilesByName(FARM_SYNC_FILE);
  if (files.hasNext()) return files.next();
  if (!createIfMissing) return null;
  return folder.createFile(FARM_SYNC_FILE, '{}', MimeType.PLAIN_TEXT);
}

function readDb_() {
  var file = getFile_(false);
  if (!file) return null;
  var txt = file.getBlob().getDataAsString('UTF-8');
  if (!txt || txt === '{}') return null;
  try { return JSON.parse(txt); } catch (err) { return null; }
}

function writeDb_(db) {
  var file = getFile_(true);
  file.setContent(JSON.stringify(db));
}

function safeCallback_(name) {
  name = String(name || '');
  return /^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(name) ? name : '';
}

function output_(callback, obj) {
  var cb = safeCallback_(callback);
  var body = cb ? cb + '(' + JSON.stringify(obj) + ');' : JSON.stringify(obj);
  var out = ContentService.createTextOutput(body);
  try {
    out.setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
  } catch (err) {
    out.setMimeType(ContentService.MimeType.TEXT);
  }
  return out;
}
