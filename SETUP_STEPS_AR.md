Step 1 (token) sent 2026-11-14. Next: step 2 = paste the token into the app; step 3 = the Shortcuts automation.

التوكن (مرة وحدة):
1. github.com ← صورتك فوق ← Settings
2. تحت: Developer settings ← Personal access tokens ← Fine-grained tokens ← Generate new token
3. Token name: masroofi ← Expiration: Custom ← سنة من اليوم
4. Repository access: Only select repositories ← masroofi-inbox
5. Permissions ← Repository permissions ← Contents: Read and write
6. Generate token ← انسخه (بيبين مرة وحدة)
7. مصروفي ← ⚙️ ← صندوق الرسائل التلقائي ← الصقه ← احفظ

الأتمتة (Shortcuts):
1. Automation (تحت) ← + ← Message
2. Sender ← Choose ← HousingBank ← Done
(إذا ما طلع: خلي Sender فاضي، وبـ Message Contains اكتب: Ref:)
3. Run Immediately، وطفّي Notify When Run ← Next ← New Blank Automation
4. Add Action ← Text ← بالمربع اختار Shortcut Input، اضغط عليه واختار Content
5. Add Action ← Base64 Encode ← اضغط السهم ← Line Breaks: None
6. Add Action ← Format Date ← Date: Current Date ← Date Format: Custom ← yyyyMMdd-HHmmss-SSS
7. Add Action ← Get Contents of URL، الرابط:
https://api.github.com/repos/hamootax-ai/masroofi-inbox/contents/inbox/
وبعده متغير Formatted Date وبعده .txt
8. اضغط السهم ← Method: PUT
Headers ← Add new header:
Authorization = Bearer (مسافة) التوكن
Accept = application/vnd.github+json
9. Request Body: JSON ← Add new field ← Text:
message = sms
content = متغير Base64 Encoded
10. Done
11. نفس الأتمتة مرة تانية للمرسل Iskan CrCrd
(أو Message Contains: credit card ending)
