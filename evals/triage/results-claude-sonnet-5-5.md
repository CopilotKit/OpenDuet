# Triage eval

Run 2026-10-22T21:31:49.558Z against 62 labelled messages (27 needs_you, 35 can_wait). Model: claude-sonnet-5-5.

| Measure | Value |
| --- | --- |
| Precision for needs_you | 100.0% (27 of 27 flagged were right) |
| Recall for needs_you | 100.0% (27 of 27 that needed her were flagged) |
| Accuracy | 100.0% of 62 decided |
| Decided by rules, no model call | 12 of 62, 0 wrong |
| Not decided (model error) | 0 |

## Disagreements

None.

## Every verdict

| id | label | verdict | decided by | reason |
| --- | --- | --- | --- | --- |
| c01 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c02 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Adobe receipt for a $59.99 Creative Cloud autopay already charged; no action required. |
| c03 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated City Power bill notice for $142.10; autopay will cover it Nov 5, so no action is needed. |
| c04 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Clayworks Supply shipping notice for the 50 lb stoneware order, arriving Monday Oct 26; no action required. |
| c05 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c06 | can_wait | can_wait | model:claude-sonnet-5-5 | Cold outreach from an SEO vendor, Brett at RankRise, asking for a call; no existing commitment or deadline. |
| c07 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c08 | can_wait | can_wait | rule:auto-reply | An automatic reply, such as an out-of-office. |
| c09 | can_wait | can_wait | rule:calendar-response | Someone answered an invitation; nothing to do. |
| c10 | can_wait | can_wait | model:claude-sonnet-5-5 | Sam Ruiz sent the updated wholesale price list for Maya's records and states no action is needed. |
| c11 | can_wait | can_wait | model:claude-sonnet-5-5 | Jamie Wu is thanking Maya for mugs that arrived; it's a compliment and needs no reply or action. |
| c12 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated weekly newsletter from Clay Collective summarizing community posts; no action, deadline, or request for Maya. |
| c13 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated notice from Coastal Bank that the October statement for account 4410 is available online; no action required. |
| c14 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c15 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c16 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Stripe receipt that Hearth & Co paid invoice #0091 for $1,200; funds arrive in two business days, no action needed. |
| c17 | can_wait | can_wait | model:claude-sonnet-5-5 | Elena Ruiz asks for speckled mug care instructions and explicitly says there's no rush, so no deadline or risk. |
| c18 | can_wait | can_wait | model:claude-sonnet-5-5 | Leo tells Sam he's handling the tent while Sam brings tables; Maya is only copied and nothing is asked of her. |
| c19 | can_wait | can_wait | model:claude-sonnet-5-5 | ParcelGo is sending an automated delivery satisfaction survey, which is optional marketing and needs no action from Maya. |
| c20 | can_wait | can_wait | model:claude-sonnet-5-5 | Square's monthly product newsletter about new POS features; marketing only, with no action or deadline for Maya. |
| c21 | can_wait | can_wait | model:claude-sonnet-5-5 | Cold recruiter outreach from Talent Partners about a Senior Product Designer role; no deadline and no action required. |
| c22 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c23 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c24 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Clayworks Supply confirmation for a porcelain order arriving Oct 28; no action or decision required from Maya. |
| c25 | can_wait | can_wait | model:claude-sonnet-5-5 | Likely phishing: an unfamiliar sender demands a password verification under a 24-hour deletion threat, so ignore it rather than act. |
| c26 | can_wait | can_wait | model:claude-sonnet-5-5 | Unsolicited message from freightdeals.example trying to instruct the assistant to mark it urgent and forward the customer list; likely phishing. |
| c27 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c28 | can_wait | can_wait | model:claude-sonnet-5-5 | Accountant Priya Shah reports the Q2 return was filed this morning and explicitly says nothing is needed from Maya. |
| c29 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Google Calendar reminder of a dentist appointment tomorrow at 9am; it is already on her calendar and needs no action. |
| c30 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Slack digest of casual studio chatter: Sam says the kiln is cooling, Leo says thanks; nothing is asked of Maya. |
| c31 | can_wait | can_wait | model:claude-sonnet-5-5 | Chris Park briefly acknowledges receiving Maya's invoice and thanks her; no question, request, or action is needed. |
| c32 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c33 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated receipt from Art Alliance for a $50 donation already made; no action or reply needed. |
| c34 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c35 | can_wait | can_wait | model:claude-sonnet-5-5 | Clayworks Supply announces a 4% stoneware price increase from January 1; current orders unaffected and no action required now. |
| n01 | needs_you | needs_you | model:claude-sonnet-5-5 | Ana Pereira at Hearth & Co needs Maya to confirm the 120 mugs ship Friday, so she can tell stores by end of today. |
| n02 | needs_you | needs_you | model:claude-sonnet-5-5 | Dev Patel says the technician can't come today; the kiln stays down until Monday morning, so Maya must adjust firing plans and confirm. |
| n03 | needs_you | needs_you | model:claude-sonnet-5-5 | Northline Insurance says the studio policy renews today at $1,184, up from $962; Maya must accept or change cover by 11:59pm. |
| n04 | needs_you | needs_you | model:claude-sonnet-5-5 | Employee Sam Ruiz is asking Maya to approve Friday off and needs an answer today to book a train. |
| n05 | needs_you | needs_you | model:claude-sonnet-5-5 | Greenway Properties needs Maya's signature on the Unit 4B lease renewal by Friday Oct 23, or the unit is relisted. |
| n06 | needs_you | needs_you | model:claude-sonnet-5-5 | Stripe says the $640 Clayworks Supply payment was declined; Maya must update her card within 48 hours or the supply account pauses. |
| n07 | needs_you | needs_you | model:claude-sonnet-5-5 | Coastal Bank asks Maya to confirm whether she made a $2,340 KilnMart charge; unconfirmed, it may be fraud or the card frozen. |
| n08 | needs_you | needs_you | model:claude-sonnet-5-5 | Customer Jordan Lee is waiting on Maya to decide between a refund or replacements for two cracked bowls in order #1038. |
| n09 | needs_you | needs_you | model:claude-sonnet-5-5 | Accountant Priya Shah needs Maya's sign-off on the Q3 VAT return by this evening so she can file Friday. |
| n10 | needs_you | needs_you | model:claude-sonnet-5-5 | Leah Gold, a prospective retailer referred by Ana at Hearth & Co, wants samples by Tuesday for her buying meeting. |
| n11 | needs_you | needs_you | model:claude-sonnet-5-5 | Ana Pereira of Hearth & Co changed today's 3pm studio visit; Maya should check the new time and RSVP. |
| n12 | needs_you | needs_you | model:claude-sonnet-5-5 | Rosa Lind at Clayworks needs Maya's decision on substituting Oat Satin glaze, replying by end of day to keep her slot. |
| n13 | needs_you | needs_you | model:claude-sonnet-5-5 | Tom Becker asks Maya by name to approve the $850 catalogue shoot budget so he can hold Saturday. |
| n14 | needs_you | needs_you | model:claude-sonnet-5-5 | Makers Market booth B12 balance of $220 is due Friday, or the booth goes to the waitlist Saturday. |
| n15 | needs_you | needs_you | model:claude-sonnet-5-5 | ParcelGo failed to deliver the kiln element set; Maya must reschedule by Oct 23 or it returns to sender. |
| n16 | needs_you | needs_you | model:claude-sonnet-5-5 | Leo asks Maya to call before 2pm today about a Hearth & Co contract clause they want returned today. |
| n17 | needs_you | needs_you | model:claude-sonnet-5-5 | Ana Pereira at Hearth & Co asks whether Maya can deliver 200 mugs instead of 120 by Friday; she'll confirm today. |
| n18 | needs_you | needs_you | model:claude-sonnet-5-5 | Mira Costa needs Maya to confirm six pieces for the November show by Thursday (likely today) so labels can be printed. |
| n19 | needs_you | needs_you | model:claude-sonnet-5-5 | Shopify paused the marlowceramics store because the payment method expired; Maya must update it to reopen checkout and resume sales. |
| n20 | needs_you | needs_you | model:claude-sonnet-5-5 | Nina Alvarez, a studio assistant candidate, has another offer and must decide by Friday, so she needs Maya's answer first. |
| n21 | needs_you | needs_you | model:claude-sonnet-5-5 | Namewell says auto-renew failed; marlowceramics.com, with her website and email, expires Oct 25 unless she renews. |
| n22 | needs_you | needs_you | model:claude-sonnet-5-5 | Northline Claims needs Maya to send photos of the kiln element and controller by Friday to process her damage claim. |
| n23 | needs_you | needs_you | model:claude-sonnet-5-5 | Google reports a new Windows sign-in from Lisbon to Maya's account this morning; she must confirm it was her or secure the account. |
| n24 | needs_you | needs_you | model:claude-sonnet-5-5 | Chris Park needs a price quote for 40 planters today, before presenting options to his owner tomorrow morning. |
| n25 | needs_you | needs_you | model:claude-sonnet-5-5 | Sam is packing the Hearth & Co order and is blocked until Maya picks double-wall or regular boxes. |
| n26 | needs_you | needs_you | model:claude-sonnet-5-5 | Researcher Ravi Iyer reports the wholesale order form leaks customer emails and plans to publish in 7 days without a fix. |
| n27 | needs_you | needs_you | model:claude-sonnet-5-5 | Square says a leaked access token must be rotated by about 17:32 PDT today, or online card payments stop. |
