// Checks for the default strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { chooseWord, decideBid } from "./strategy.js";

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

test("chooseWord picks the longest word the rack can spell", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  assert.equal(chooseWord({ myRack: rack("TACT"), dictionary }), "TACT");
  assert.equal(chooseWord({ myRack: rack("CATX"), dictionary }), "CAT");
  assert.equal(chooseWord({ myRack: rack("CX"), dictionary }), null);
});

test("decideBid values letters toward words even when several letters are missing", () => {
  const myRack = rack("AT");
  const dictionary = ["CAT", "AT", "DOG"];

  const context = {
    myScore: 10,
    isVickrey: true,
    opponents: [],
    myRack,
    dictionary,
  };
  assert.ok(decideBid({ ...context, letter: "C", myBalance: 100 }) > 0);
  assert.equal(decideBid({ ...context, letter: "Z", myBalance: 100 }), 0);
  assert.equal(decideBid({ ...context, letter: "C", myBalance: 1 }), 1);
  assert.equal(
    decideBid({
      ...context,
      letter: "Q",
      myRack: rack(""),
      dictionary: ["QUIZZES"],
      myBalance: 100,
    }),
    38,
  );
  assert.equal(
    decideBid({
      ...context,
      letter: "A",
      myRack: rack(""),
      dictionary: ["AA"],
      myBalance: 100,
    }),
    4,
  );
});

test("Vickrey bids approach tile value and respect the larger balance cap", () => {
  const context = {
    letter: "Q",
    myBalance: 100,
    myScore: 10,
    isVickrey: true,
    myRack: rack("UIZ"),
    dictionary: ["QUIZ"],
  };
  const normalBid = decideBid({ ...context, opponents: [] });
  const trailingOpponentBid = decideBid({
    ...context,
    opponents: [{ score: 8, winningPayments: [50] }],
  });
  const competitiveOpponentBid = decideBid({
    ...context,
    opponents: [{ score: 9, winningPayments: [50] }],
  });

  assert.equal(normalBid, 33);
  assert.equal(trailingOpponentBid, normalBid);
  assert.equal(competitiveOpponentBid, normalBid);
  assert.equal(
    decideBid({
      ...context,
      myBalance: 10,
      opponents: [{ score: 10, winningPayments: [50] }],
    }),
    8,
  );
  const firstPriceBid = decideBid({
    ...context,
    isVickrey: false,
    opponents: [{ score: 10, winningPayments: [12] }],
  });
  assert.equal(firstPriceBid, 21);
  assert.equal(
    decideBid({
      ...context,
      isVickrey: false,
      opponents: [{ score: 10, winningPayments: [12] }],
    }),
    firstPriceBid,
  );

  const lowValueContext = {
    ...context,
    letter: "C",
    myRack: rack("AT"),
    dictionary: ["CAT"],
  };
  assert.equal(
    decideBid({
      ...lowValueContext,
      opponents: [{ score: 10, winningPayments: [40] }],
    }),
    decideBid({ ...lowValueContext, opponents: [] }),
  );
});

test("Vickrey bids adapt to recent outcomes and remaining auctions", () => {
  const context = {
    letter: "Q",
    myBalance: 100,
    myScore: 10,
    isVickrey: true,
    myRack: rack("UIZ"),
    dictionary: ["QUIZ"],
    opponents: [],
    bagRemaining: 84,
    playersInMatch: 6,
  };

  const earlyBudgetBid = decideBid(context);
  const losingStreakBid = decideBid({
    ...context,
    recentWinRate: 0,
    recentBidCount: 4,
  });
  const winningStreakBid = decideBid({
    ...context,
    recentWinRate: 1,
    recentBidCount: 4,
  });
  const lateMatchBid = decideBid({ ...context, bagRemaining: 6 });

  assert.equal(earlyBudgetBid, 15);
  assert.equal(losingStreakBid, 20);
  assert.equal(winningStreakBid, 10);
  assert.equal(lateMatchBid, 33);
});

test("chooseWord holds tiles for a strong word unless funds or bag are low", () => {
  const dictionary = ["CAT", "AT"];
  const myRack = rack("CAT");

  assert.equal(chooseWord({ myRack, dictionary, myBalance: 100 }), null);
  assert.equal(chooseWord({ myRack, dictionary, myBalance: 10 }), "CAT");
  assert.equal(
    chooseWord({ myRack, dictionary, myBalance: 100, bagRemaining: 0 }),
    "CAT",
  );
  assert.equal(
    chooseWord({ myRack: rack("QUIZZES"), dictionary: ["QUIZZES"], myBalance: 100 }),
    "QUIZZES",
  );
});

// The bot can't see a match move on while it searches, so a slow search
// means bids on closed auctions and words from letters it already spent.
test("chooseWord searches the whole wordlist well within an auction", () => {
  const dictionary = fs
    .readFileSync(
      new URL("../../spacetimedb/wordlist.txt", import.meta.url),
      "utf8",
    )
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2)
    .sort((a, b) => b.length - a.length);
  // The largest rack an admin can set, with almost nothing to spell.
  const myRack = rack("BCDFGHJKLMNPQRSTVWXZ");
  const start = performance.now();
  chooseWord({ myRack, dictionary });
  assert.ok(performance.now() - start < 100, "a search took 100 ms or more");
});
