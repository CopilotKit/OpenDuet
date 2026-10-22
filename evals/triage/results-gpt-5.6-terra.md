# Triage eval

Run 2026-10-21T22:15:16.910Z against 60 labelled messages (25 needs_you, 35 can_wait). Model: gpt-5.6-terra.

| Measure | Value |
| --- | --- |
| Precision for needs_you | 96.2% (25 of 26 flagged were right) |
| Recall for needs_you | 100.0% (25 of 25 that needed her were flagged) |
| Accuracy | 98.3% of 60 decided |
| Decided by rules, no model call | 16 of 60, 0 wrong |
| Not decided (model error) | 0 |

## Disagreements
- **c29** "Reminder: Dentist @ Fri Oct 23 9am": labelled can_wait, got needs_you by model:gpt-5.6-terra. Its reason: "Maya has a dentist appointment tomorrow, October 23, at 9am.". Label's reason: "A reminder of an appointment already on her calendar."

## Every verdict

| id | label | verdict | decided by | reason |
| --- | --- | --- | --- | --- |
| c01 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c02 | can_wait | can_wait | model:gpt-5.6-terra | Adobe confirms the $59.99 Creative Cloud autopay was already paid. |
| c03 | can_wait | can_wait | model:gpt-5.6-terra | City Power says the $142.10 bill will be paid automatically by autopay on November 5. |
| c04 | can_wait | can_wait | model:gpt-5.6-terra | Clayworks Supply confirms order CW-8812 has shipped and is expected Monday, October 26. |
| c05 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c06 | can_wait | can_wait | model:gpt-5.6-terra | Brett at RankRise is making unsolicited SEO outreach and asks for 15 minutes this week. |
| c07 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c08 | can_wait | can_wait | rule:auto-reply | An automatic reply, such as an out-of-office. |
| c09 | can_wait | can_wait | rule:calendar-response | Someone answered an invitation; nothing to do. |
| c10 | can_wait | can_wait | model:gpt-5.6-terra | Sam shared an updated wholesale price list for Maya’s records and explicitly says no action is needed. |
| c11 | can_wait | can_wait | model:gpt-5.6-terra | Jamie Wu is thanking Maya for mugs that have already arrived, with no action requested. |
| c12 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c13 | can_wait | can_wait | model:gpt-5.6-terra | Coastal Bank’s automated notice only says the October statement for account ending 4410 is available online. |
| c14 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c15 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c16 | can_wait | can_wait | model:gpt-5.6-terra | Stripe confirms Hearth & Co paid invoice #0091; funds will arrive automatically in two business days. |
| c17 | can_wait | can_wait | model:gpt-5.6-terra | Elena Ruiz requests speckled mug care instructions but explicitly says there is no rush. |
| c18 | can_wait | can_wait | model:gpt-5.6-terra | Leo confirms he and Sam have market logistics handled; Maya is only copied. |
| c19 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c20 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c21 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c22 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c23 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c24 | can_wait | can_wait | model:gpt-5.6-terra | Clayworks Supply confirms the porcelain order; no action is requested before its Oct 28 arrival. |
| c25 | can_wait | can_wait | model:gpt-5.6-terra | This is a suspected phishing password-verification request from Mail Admin, so Maya should not act on it. |
| c26 | can_wait | can_wait | model:gpt-5.6-terra | This is an unsolicited instruction from freightdeals.example, not a request requiring Maya’s action. |
| c27 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c28 | can_wait | can_wait | model:gpt-5.6-terra | Priya Shah confirms the Q2 return was filed this morning and says Maya needs to do nothing. |
| c29 | can_wait | needs_you | model:gpt-5.6-terra | Maya has a dentist appointment tomorrow, October 23, at 9am. |
| c30 | can_wait | can_wait | model:gpt-5.6-terra | Slack notification only reports Sam saying the kiln is cooling and Leo thanking them; no action is requested. |
| c31 | can_wait | can_wait | model:gpt-5.6-terra | Chris Park is only acknowledging receipt of Maya's invoice and requests no action. |
| c32 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c33 | can_wait | can_wait | model:gpt-5.6-terra | Art Alliance confirms Maya's $50 donation and provides a receipt; no action is requested. |
| c34 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c35 | can_wait | can_wait | model:gpt-5.6-terra | Clayworks Supply announced a 4% stoneware price increase effective January 1; current orders are unaffected. |
| n01 | needs_you | needs_you | model:gpt-5.6-terra | Ana at Hearth & Co needs Maya’s confirmation today that 120 mugs will ship Friday. |
| n02 | needs_you | needs_you | model:gpt-5.6-terra | Dev Patel says the kiln will remain out of service until Monday morning, affecting studio operations. |
| n03 | needs_you | needs_you | model:gpt-5.6-terra | Northline Insurance requires Maya to review or change studio policy STU-44120 before 11:59pm today. |
| n04 | needs_you | needs_you | model:gpt-5.6-terra | Sam Ruiz needs Maya’s decision today on taking Friday off before booking the train. |
| n05 | needs_you | needs_you | model:gpt-5.6-terra | Greenway Properties needs Maya to sign the Unit 4B lease renewal by Oct 23 or it returns to market. |
| n06 | needs_you | needs_you | model:gpt-5.6-terra | Stripe says Marlow Ceramics must update its payment method within 48 hours to prevent Clayworks Supply account suspension. |
| n07 | needs_you | needs_you | model:gpt-5.6-terra | Coastal Bank needs Maya to confirm or dispute a $2,340.00 KILNMART ONLINE charge promptly. |
| n08 | needs_you | needs_you | model:gpt-5.6-terra | Jordan Lee requests a refund or replacements for two cracked bowls in order #1038. |
| n09 | needs_you | needs_you | model:gpt-5.6-terra | Priya needs Maya’s sign-off on the Q3 VAT return by Thursday evening to file Friday. |
| n10 | needs_you | needs_you | model:gpt-5.6-terra | Leah Gold requests Marlow samples by Tuesday for Golden Hour’s buying meeting. |
| n11 | needs_you | needs_you | model:gpt-5.6-terra | Ana Pereira moved the Hearth & Co studio visit to today from 3–4pm, requiring Maya’s attendance confirmation. |
| n12 | needs_you | needs_you | model:gpt-5.6-terra | Rosa needs Maya’s decision on the Oat Satin substitute by end of day to keep the shipment slot. |
| n13 | needs_you | needs_you | model:gpt-5.6-terra | Tom Becker needs Maya’s approval of the $850 budget to reserve Saturday’s catalogue shoot. |
| n14 | needs_you | needs_you | model:gpt-5.6-terra | Maya must pay Makers Market’s $220 booth B12 balance by Friday to avoid release to the waitlist Saturday. |
| n15 | needs_you | needs_you | model:gpt-5.6-terra | ParcelGo requires Maya to reschedule the kiln element delivery by Oct 23 to avoid return. |
| n16 | needs_you | needs_you | model:gpt-5.6-terra | Leo needs Maya to discuss a Hearth contract clause before 2 today, with the contract due back today. |
| n17 | needs_you | needs_you | model:gpt-5.6-terra | Ana at Hearth & Co. needs Maya’s confirmation today on increasing the Friday mug order to 200. |
| n18 | needs_you | needs_you | model:gpt-5.6-terra | Mira Costa needs Maya to confirm six November show pieces by Thursday for label printing. |
| n19 | needs_you | needs_you | model:gpt-5.6-terra | Maya must update the expired Shopify payment method to reopen checkout for marlowceramics.myshopify.com. |
| n20 | needs_you | needs_you | model:gpt-5.6-terra | Nina Alvarez needs Maya’s decision on the studio assistant role by Friday before accepting another offer. |
| n21 | needs_you | needs_you | model:gpt-5.6-terra | Namewell says auto-renew failed; Maya must renew marlowceramics.com before Oct 25 to avoid website and email disruption. |
| n22 | needs_you | needs_you | model:gpt-5.6-terra | Northline Claims needs Maya to provide kiln element and controller photos by Friday for claim CL-2209. |
| n23 | needs_you | needs_you | model:gpt-5.6-terra | Google reports a new Windows sign-in from Lisbon; Maya should verify and secure the account immediately if unrecognized. |
| n24 | needs_you | needs_you | model:gpt-5.6-terra | Chris Park needs Maya’s quote for 40 planters today before presenting options tomorrow morning. |
| n25 | needs_you | needs_you | model:gpt-5.6-terra | Sam Ruiz is blocked packing the Hearth order and needs Maya to choose box type now. |
