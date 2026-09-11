ACONA STORE — تشغيل الباك اند (Windows)
=====================================

1) ثبّت Node.js LTS من: https://nodejs.org
   (تحقق بالأمر: node --version)

2) افتح PowerShell في مجلد backend:
   cd "C:\Users\Pc\OneDrive\Desktop\ACONA STORE\backend"

3) شغّل السيرفر (بدون npm install — لا توجد مكتبات):
   node server.js

4) افتح الموقع عبر السيرفر (مهم!):
   http://localhost:3000/ACONA.html
   لوحة الإدارة:
   http://localhost:3000/admin.html

ملاحظات مهمة:
- لا تفتح الموقع بملف file:// عند استخدام الباك اند؛ الـ API يعمل فقط عبر http://localhost:3000
- إذا كان السيرفر مطفياً، الموقع يشتغل تلقائياً بالوضع المحلي (منتجات مدمجة + طلب وهمي) بدون أي خطأ.
- الطلبات تُحفظ في: backend\data\orders.json
- غيّر توكن الإدارة في الإنتاج:
  $env:ADMIN_TOKEN="كلمة-سر-قوية" ; node server.js
- المنافذ: لتغيير البورت: $env:PORT=8080 ; node server.js

الـ API:
  GET  /api/health
  GET  /api/products
  POST /api/orders       (السعر يُحسب في السيرفر — لا يُؤخذ من الزبون)
  GET  /api/orders/ACN-123456?phone=06...
  POST /api/newsletter
  GET  /api/admin/orders (هيدر x-admin-token)
