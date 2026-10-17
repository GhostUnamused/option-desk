# Contributing

Thanks for helping. Optionwise is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). By sending a contribution you agree that it is licensed under the same terms and that the author may include it in the project, including any future licence changes by the author.

## Ground rules

- **Paper trading only.** Pull requests that add real order placement will not be merged.
- **Zero npm dependencies.** The app uses only Node's built-in modules. Please keep it that way unless there is a strong reason.
- **Plain language.** Interface text is written for beginners; explain finance terms where they appear.
- **No secrets, no data.** Never commit `.env`, tokens or anything from the data folder.
- **Replay must not look ahead.** Market reads in replay go through `lib/replay/snapshot.js`, and `test/snapshot.test.js` must keep passing.

## Setup

1. Install Node.js 22.13 or newer.
2. `node server.js --sim` for replay mode, or `node server.js` for live prices. The page opens at http://localhost:4321.
3. `npm test` runs the test suite. Please add a test for new logic.

`CLAUDE.md` describes the code layout in detail.

## Good first issues

Testing a broker adapter (FYERS, Upstox, Kotak Neo, ICICI Breeze or Angel One) with your own account and reporting what works is the most useful help right now. Limit and stop orders in the paper engine, and more strategy presets, are also open.
