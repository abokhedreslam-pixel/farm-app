# رفع تطبيق المزرعة على GitHub Pages

## الملفات المهمة
ارفع كل الملفات الموجودة في المجلد ده إلى GitHub:

- `index.html`
- `manifest.json`
- `service-worker.js`
- `icon-192.png`
- `icon-512.png`
- `google_apps_script_sync.gs` اختياري، ده كود المزامنة فقط ومش لازم يتفتح للمستخدم.

## خطوات GitHub Pages

1. افتح https://github.com وسجل دخول.
2. اضغط زر **+** فوق يمين، ثم **New repository**.
3. اكتب اسم المستودع مثلًا:
   `farm-app`
4. خلي المستودع **Public**.
5. اضغط **Create repository**.
6. داخل المستودع، اضغط **Add file > Upload files**.
7. ارفع الملفات الموجودة في هذا المجلد، وليس المجلد نفسه.
8. اضغط **Commit changes**.
9. من المستودع افتح **Settings**.
10. من الشمال افتح **Pages**.
11. عند **Build and deployment** اختار:
    - Source: **Deploy from a branch**
    - Branch: **main**
    - Folder: **/root**
12. اضغط **Save**.
13. انتظر دقيقة أو دقيقتين. سيظهر رابط مثل:
    `https://USERNAME.github.io/farm-app/`

افتح الرابط من Chrome على أندرويد، ثم من القائمة اختر **Install app** أو **Add to Home screen**.

## المزامنة بين الموبايل والكمبيوتر
بعد فتح التطبيق من رابط GitHub Pages على الجهازين:

1. اعمل Google Apps Script من ملف `google_apps_script_sync.gs`.
2. انسخ رابط Web App الذي ينتهي بـ `/exec`.
3. افتح التطبيق على الكمبيوتر والموبايل.
4. ادخل **الأدوات والنسخ**.
5. الصق رابط Google Apps Script في خانة **رابط Google Apps Script للمزامنة**.
6. خلي **المزامنة التلقائية بعد الحفظ = مفعلة**.
7. اضغط **حفظ الإعدادات**.
8. اضغط **مزامنة الآن**.

لو البيانات القديمة موجودة على الكمبيوتر، اعمل أول مزامنة من الكمبيوتر الأول، وبعدها افتح الموبايل واضغط مزامنة الآن.
