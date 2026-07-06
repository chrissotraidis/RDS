# Dockside Meal Planner — Client Research (Fixture)

> Fixture research document used to smoke-test the green-field path.
> Not a real client. Realistic enough that Wiki can produce a
> meaningful spec from it. See also `inbox/fixture-prd.md` for the
> brown-field fixture.

## 1. Client

**Dockside Kitchen** is a 2-person catering operation in coastal Maine that
sells weekly meal subscriptions to boat owners who stay aboard in the summer.
Orders are coordinated today over text messages and a spreadsheet; they
want a small web app that replaces the spreadsheet.

Primary contact: Jess Hale (owner). No developer on staff.

## 2. What they want (in their own words)

> *"We need a way for customers to pick meals for next week, tell us how
> many people are on the boat, and pay a deposit. Then we need to see a
> single screen on Sunday night that tells us what to cook on Monday
> morning. That's it. No accounts, no app to download, email link is
> fine."*

## 3. Users

- **Customer** (boat owner) — receives a weekly email with a link, selects
  meals for the following week from a fixed menu of 6 items, specifies
  headcount per day, and pays a 50% deposit.
- **Operator** (Jess or her co-cook) — logs in to a back-office screen,
  sees the cook list for the week, can edit menus, can export a shopping
  list.

## 4. Workflow

1. Sunday evening — operator publishes next week's menu (6 items,
   sometimes reused from previous weeks).
2. Monday morning — Postmark sends each active subscriber a personalized
   email with a magic link.
3. Subscriber opens the link, selects meals per day, enters headcount,
   pays deposit via Stripe.
4. Wednesday end-of-day — order window closes. Late orders are manual
   (operator adds them by hand in the back office).
5. Friday morning — operator views a consolidated "cook list" screen,
   grouped by meal, with total headcount and per-boat notes. Clicks
   "export shopping list" → PDF.

## 5. Constraints

- Must run on US East infrastructure; Jess's customers are in Maine.
- Email-only auth (magic links) for customers. No passwords.
- Operator login is simple email + password — two operators total.
- Mobile-responsive. Half of customers open the email on an iPad; the
  other half on an iPhone.
- Stripe for payments; 50% deposit at order time, remainder billed
  Friday after the shop.
- Zero-maintenance posture: the owner cannot debug a broken page. The
  app must fail visibly (clear error, "contact us" link) rather than
  silently.

## 6. Non-goals

- No recipe management.
- No delivery tracking (everything is picked up dockside).
- No customer loyalty / referrals.
- No native mobile app.
- No multi-tenant — single Dockside Kitchen instance only.

## 7. Data we already know

- Menu items are stable: they rotate across ~40 total recipes. Each has
  a title, short description, protein tag (chicken / fish / veg), and a
  base price.
- ~60 active subscribers. Peaks near the 4th of July (~90).
- 6 meals per week is a hard cap from the kitchen.
- Orders close Wednesday 9pm Eastern.

## 8. Open questions (for Wiki to flag)

These are things Jess hasn't answered; Wiki should surface them in
`po-questions.md` and continue with a best-effort default:

1. What happens if a subscriber places an order and then a meal gets
   removed from the menu after the fact?
2. Who handles refunds if a customer cancels mid-week?
3. Does the magic link expire? After how long?
4. Can one customer manage headcount for multiple boats?

## 9. Nice-to-haves (future)

- Text-message notification fallback when email delivery fails.
- Per-boat notes visible to customer ("your usual mooring, slip 14").
- Simple repeat-last-week button.

## 10. Branding / vibe

Simple, a little nautical. Cool blues and sand tones. No heavy imagery —
Jess's phone connection on the dock is flaky.
