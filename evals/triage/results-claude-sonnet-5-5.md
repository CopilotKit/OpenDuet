# Triage eval

Run 2026-10-22T00:48:05.052Z against 60 labelled messages (25 needs_you, 35 can_wait). Model: claude-sonnet-5-5.

| Measure | Value |
| --- | --- |
| Precision for needs_you | 100.0% (24 of 24 flagged were right) |
| Recall for needs_you | 100.0% (24 of 24 that needed her were flagged) |
| Accuracy | 100.0% of 59 decided |
| Decided by rules, no model call | 16 of 60, 0 wrong |
| Not decided (model error) | 1 |

## Disagreements

None.

## Errors
- **n23**: The operation timed out.

## Every verdict

| id | label | verdict | decided by | reason |
| --- | --- | --- | --- | --- |
| c01 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c02 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Adobe receipt for a $59.99 Creative Cloud autopay already charged; no action required. |
| c03 | can_wait | can_wait | model:claude-sonnet-5-5 | City Power's automated notice says the $142.10 October bill will be paid by autopay on Nov 5, so no action is needed. |
| c04 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Clayworks Supply shipping notice for order CW-8812, stoneware arriving Monday Oct 26; no action required. |
| c05 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c06 | can_wait | can_wait | model:claude-sonnet-5-5 | Cold outreach from Brett at RankRise, an SEO vendor asking for a 15-minute call; no commitment or deadline involved. |
| c07 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c08 | can_wait | can_wait | rule:auto-reply | An automatic reply, such as an out-of-office. |
| c09 | can_wait | can_wait | rule:calendar-response | Someone answered an invitation; nothing to do. |
| c10 | can_wait | can_wait | model:claude-sonnet-5-5 | Sam Ruiz sent the updated wholesale price list for her records only, and explicitly says no action is needed. |
| c11 | can_wait | can_wait | model:claude-sonnet-5-5 | Jamie Wu is thanking Maya for mugs that arrived; it's a compliment with no question or action needed. |
| c12 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c13 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated notice from Coastal Bank that the October statement for account 4410 is available; no action or deadline mentioned. |
| c14 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c15 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c16 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Stripe receipt: Hearth & Co paid invoice #0091 for $1,200, funds arriving in two business days, no action needed. |
| c17 | can_wait | can_wait | model:claude-sonnet-5-5 | Elena Ruiz asks for speckled mug care instructions and explicitly says there is no rush, so no deadline. |
| c18 | can_wait | can_wait | model:claude-sonnet-5-5 | Leo tells Sam he's handling the tent and Sam is bringing tables; Maya is only copied and nothing is asked of her. |
| c19 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c20 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c21 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c22 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c23 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c24 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Clayworks Supply order confirmation for 50 lb porcelain arriving Oct 28; no action or decision required from Maya. |
| c25 | can_wait | can_wait | model:claude-sonnet-5-5 | Likely phishing: unknown sender demands password verification under a 24-hour deletion threat; no genuine action required from Maya. |
| c26 | can_wait | can_wait | model:claude-sonnet-5-5 | Unsolicited message from freightdeals.example that tries to instruct the assistant, including forwarding the customer list; likely phishing, so it was ignored. |
| c27 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c28 | can_wait | can_wait | model:claude-sonnet-5-5 | Accountant Priya Shah reports she filed the Q2 return this morning and explicitly says nothing is needed from Maya. |
| c29 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Google Calendar reminder of Maya's own dentist appointment tomorrow at 9am; no action or decision is required. |
| c30 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated Slack digest of #studio chatter: Sam says kiln is cooling, Leo says thanks; no question or action for Maya. |
| c31 | can_wait | can_wait | model:claude-sonnet-5-5 | Chris Park just acknowledges receiving Maya's invoice with thanks; no question, request, or deadline needs her action. |
| c32 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c33 | can_wait | can_wait | model:claude-sonnet-5-5 | Automated receipt from Art Alliance for a $50 donation already made; nothing to approve, pay, or reply to. |
| c34 | can_wait | can_wait | rule:bulk | Bulk mail: a newsletter, promotion or digest. |
| c35 | can_wait | can_wait | model:claude-sonnet-5-5 | Clayworks Supply announces a 4% stoneware price increase from January 1; current orders unaffected and no action required now. |
| n01 | needs_you | needs_you | model:claude-sonnet-5-5 | Ana Pereira at Hearth & Co needs Maya to confirm the 120 mugs ship Friday so she can tell stores by end of today. |
| n02 | needs_you | needs_you | model:claude-sonnet-5-5 | Dev Patel's kiln technician cancelled today's (Thursday) visit; earliest is Monday morning, so Maya must confirm and adjust production plans. |
| n03 | needs_you | needs_you | model:claude-sonnet-5-5 | Northline Insurance studio policy STU-44120 renews today at $1,184, up from $962; Maya must accept or change cover before 11:59pm. |
| n04 | needs_you | needs_you | model:claude-sonnet-5-5 | Sam Ruiz is asking Maya to approve Friday off and needs an answer today to book a train. |
| n05 | needs_you | needs_you | model:claude-sonnet-5-5 | Greenway Properties needs Maya to sign the Unit 4B lease renewal by Friday Oct 23 or lose the unit. |
| n06 | needs_you | needs_you | model:claude-sonnet-5-5 | Card declined on $640 Clayworks Supply payment; must update payment method within 48 hours or supply account gets paused. |
| n07 | needs_you | needs_you | model:claude-sonnet-5-5 | Coastal Bank wants Maya to confirm whether a $2,340 KilnMart charge was hers; unanswered, the card may be frozen. |
| n08 | needs_you | needs_you | model:claude-sonnet-5-5 | Customer Jordan Lee is waiting on Maya to choose a refund or replacement for two cracked bowls in order #1038. |
| n09 | needs_you | needs_you | model:claude-sonnet-5-5 | Accountant Priya Shah needs Maya's sign-off on the Q3 VAT return by this evening so she can file Friday. |
| n10 | needs_you | needs_you | model:claude-sonnet-5-5 | Leah Gold of Golden Hour, referred by Ana at Hearth & Co, wants samples by Tuesday for her buying meeting. |
| n11 | needs_you | needs_you | model:claude-sonnet-5-5 | Ana Pereira of Hearth & Co changed today's 3pm studio visit; Maya should check the new time and RSVP. |
| n12 | needs_you | needs_you | model:claude-sonnet-5-5 | Rosa Lind at Clayworks Supply needs Maya's decision on substituting Oat Satin glaze, with a reply due today to keep her slot. |
| n13 | needs_you | needs_you | model:claude-sonnet-5-5 | Tom Becker asks Maya by name to approve the $850 catalogue shoot budget so he can hold Saturday. |
| n14 | needs_you | needs_you | model:claude-sonnet-5-5 | Makers Market wants the $220 booth B12 balance paid by Friday, or the booth goes to the waitlist Saturday. |
| n15 | needs_you | needs_you | model:claude-sonnet-5-5 | ParcelGo failed to deliver the kiln element set; Maya must reschedule by Oct 23 or it returns to sender. |
| n16 | needs_you | needs_you | model:claude-sonnet-5-5 | Leo asks Maya to call him before 2pm today about a Hearth contract clause he dislikes; Hearth wants it back today. |
| n17 | needs_you | needs_you | model:claude-sonnet-5-5 | Ana Pereira at Hearth & Co asks whether Maya can make 200 mugs instead of 120 by Friday, wants an answer today. |
| n18 | needs_you | needs_you | model:claude-sonnet-5-5 | Mira Costa at Costa Gallery needs Maya to confirm her six November show pieces by today (Thursday) so labels can be printed. |
| n19 | needs_you | needs_you | model:claude-sonnet-5-5 | Shopify paused marlowceramics.myshopify.com checkout because her payment method expired; she must update it to resume sales. |
| n20 | needs_you | needs_you | model:claude-sonnet-5-5 | Nina Alvarez, a studio assistant candidate, has another offer and needs Maya's answer before her Friday decision deadline. |
| n21 | needs_you | needs_you | model:claude-sonnet-5-5 | Namewell says auto-renew failed; Maya must renew marlowceramics.com by Oct 25 or lose her website and email. |
| n22 | needs_you | needs_you | model:claude-sonnet-5-5 | Northline Claims needs Maya's photos of the kiln element and controller by tomorrow (Friday) to keep claim CL-2209 moving. |
| n23 | needs_you | - | - | The operation timed out. |
| n24 | needs_you | needs_you | model:claude-sonnet-5-5 | Chris Park needs a price quote for 40 planters today because he presents options to his owner tomorrow morning. |
| n25 | needs_you | needs_you | model:claude-sonnet-5-5 | Sam Ruiz is stuck packing the Hearth order and needs Maya to choose double-wall or regular boxes. |
