# RB Stumbler

Redbubble is enormous and full of filler. RB Stumbler cuts through it and hands you
one design at a time.

It picks a search from your list, searches Redbubble, throws out anything that
doesn't match your filters, and shows you what's left. You say yes or no. Repeat.

Think Stumbleupon, but for a marketplace.

## Install (Chrome)

1. Unzip the folder somewhere permanent, like your Documents folder
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and pick the folder
5. Click the puzzle-piece icon in your toolbar and pin **RB Stumbler**

## Using it

Click the toolbar icon, then press **Stumble** (or just hit <kbd>Enter</kbd>).

| Button | What it does |
| --- | --- |
| **Stumble** | Show me another design |
| **Open** | Open it on Redbubble in a tab |
| **Heart** | Save it as a favourite on Redbubble (you click the button — nothing happens on its own) |
| **Save to board** | Keep it in your own private collection, inside the extension |
| **Similar** | Show me designs like this one |
| **Reroll** | Next design from the same search |
| **Dismiss** | Never show this one again. **Red**, so you don't tap it by accident |
| **Block shop** | Adds that shop to your filter list. **Red**, and you can remove it again in Filters |

Shortcuts: <kbd>O</kbd> open · <kbd>R</kbd> reroll ·
<kbd>S</kbd> similar · <kbd>D</kbd> dismiss · <kbd>B</kbd> save · <kbd>Z</kbd> undo.
<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> works from any page.

## The tabs

- **Stumble** — the main screen, and all the buttons. Tick *Auto-stumble* or
  *Auto-reroll* to let it turn itself over on a timer
- **Queries** — your search list. 50 are included; untick the bad ones, add your own
- **Filters** — hide designs by price, unwanted words, unwanted shops, or product type
  — or flip it round and allow *only* certain shops
- **Settings** — colours, text size, how it picks
- **Board** — everything you saved, exportable as a spreadsheet
- **History** — everything you've seen, and what you thought of it

## What's new in 0.5.0

- **Auto-reroll** — a second timer beside Auto-stumble. It works through the
  results already on your screen, so it never uses up a search. When that runs
  out, it quietly carries on with a normal stumble.
- **Only these shops** — the opposite of the shop blocklist. Tick it, add the
  shops you actually like, and everything else gets dropped. Whole shop names
  only: `isabel` won't sneak `isabelshop123` through.

- **Block shop** — a button on the Stumble screen adds the shop you're looking
  at to your filter list. One tap instead of typing the name in Filters, and you
  can delete it from there whenever you change your mind.
- **Skip is gone.** It did the same job as Dismiss minus the bit that made
  Dismiss worth having. One button instead of two that looked identical.
- **Dismiss and Block shop are red.** They're the only two buttons that throw
  something away, and they sit right next to Heart and Save to board.
- **Reroll fixed** — if Stumble order was anything other than Random, rerolling
  would get stuck alternating between the same two designs. It now walks the
  whole pool.
- **"Dealt" is gone.** Everything now says "shown" or "seen". Your existing
  history and settings carry over untouched.

## Things worth knowing

**Every search is used once before any repeats.** You'll get a proper mix instead of
the same two searches forever.

**It tells you what it threw away.** If a search comes back with nothing, you get
told which filter did it — not just that "something" did.

**"Stumble order" controls both what Redbubble searches for and which result you
get.** `Random` by default. Or pick `Most recent`, `Top selling`, `Trending`,
`Cheapest first` — all the way through to `Most relevant`.

**It can learn.** Turn on *Let your hearts steer future stumbles* and every heart
you give gradually nudges it toward shops and words you like. It still stays
random, so it never gets stuck showing you one thing.

**Nothing leaves your computer.** No account, no tracking, no sending anything
anywhere. It only ever looks at Redbubble, the same way you would. Your settings
live in your browser.

## When something goes wrong

Redbubble redesigns their site now and then, which occasionally confuses it.

**Try the search yourself.** Go to Settings → Data → **Show search tab**. That
brings the hidden search tab forward so you can see what it's looking at. If
Redbubble showed a "checking your browser" challenge, clear it there and Stumble
again.

**Try turning up the search.** Settings → Search → **Pages**. Going from 1 to 2 or 3
gives it more to choose from.

If you edited any files, press **Reload** on the extensions page to pick up your
changes.

## Not included, on purpose

No proxy hiding, no pretending to be a different browser, no automatic clicking
through "I'm not a robot" boxes. It's built for looking at a handful of designs,
not farming a marketplace.