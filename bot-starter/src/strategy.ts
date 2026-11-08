// Edit this file to implement your bidding and word-forming strategy.

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

interface WordInfo {
  word: string;
  score: number;
  letterCount: number;
}

const indexedWords = new WeakMap<string[], Map<string, WordInfo[]>>();
const FIRST_PRICE_MAX_BALANCE_BID_FRACTION = 0.35;
const VICKREY_MAX_BALANCE_BID_FRACTION = 0.8;
const MAX_VICKREY_BUDGET_FRACTION = 2;
const EXPECTED_MATCH_SIZE = 6;
const MIN_USEFUL_VICKREY_BID = 4;
const FIRST_PRICE_VALUE_FRACTION = 0.65;
const DEFENSE_OBSERVED_PAYMENT_FRACTION = 0.8;
const DEFENSE_VALUE_FRACTION = 0.8;
const WORD_VALUE_FRACTION_TO_PLAY = 0.35;
const MIN_BALANCE_TO_HOLD = 18;
const MAX_BALANCE_TO_HOLD = 30;

export interface BidContext {
  letter: string;
  myBalance: number;
  myScore: number;
  myRack: Map<string, number>;
  dictionary: string[];
  isVickrey: boolean;
  opponents: { score: number; winningPayments: number[] }[];
  bagRemaining?: number;
  playersInMatch?: number;
  recentWinRate?: number;
  recentBidCount?: number;
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[];
  myBalance?: number;
  bagRemaining?: number;
}

function reward(word: string): number {
  let baseScore = 0;
  for (const letter of word) baseScore += LETTER_VALUE[letter] ?? 0;

  if (word.length <= 3) return baseScore;
  if (word.length === 4) return Math.floor((baseScore * 3) / 2);
  if (word.length === 5) return baseScore * 2;
  if (word.length === 6) return Math.floor((baseScore * 5) / 2);
  return baseScore * 3;
}

function wordsContaining(dictionary: string[], letter: string): WordInfo[] {
  let byLetter = indexedWords.get(dictionary);
  if (!byLetter) {
    byLetter = new Map();
    indexedWords.set(dictionary, byLetter);
  }
  let words = byLetter.get(letter);
  if (!words) {
    words = [];
    for (const word of dictionary) {
      let letterCount = 0;
      for (const c of word) {
        if (c === letter) letterCount++;
      }
      if (letterCount > 0) {
        words.push({ word, score: reward(word), letterCount });
      }
    }
    byLetter.set(letter, words);
  }
  return words;
}

export function decideBid(ctx: BidContext): number {
  const balance = Math.max(0, Math.floor(ctx.myBalance));
  if (balance === 0) return 0;

  const letter = ctx.letter.toUpperCase();
  const letterIndex = letter.charCodeAt(0) - 65;
  if (letterIndex < 0 || letterIndex >= 26) return 0;
  const words = wordsContaining(ctx.dictionary, letter);
  const rackCounts = new Uint8Array(26);
  for (const [c, count] of ctx.myRack) {
    const index = c.charCodeAt(0) - 65;
    if (index >= 0 && index < 26) rackCounts[index] = count;
  }
  const usedCounts = new Uint8Array(26);
  const touchedIndices = new Uint8Array(26);
  let bestLetterValue = 0;

  for (const { word, score, letterCount } of words) {
    let missingBefore = 0;
    let touchedCount = 0;
    for (const c of word) {
      const index = c.charCodeAt(0) - 65;
      if (index < 0 || index >= 26) continue;
      if (usedCounts[index] === 0) touchedIndices[touchedCount++] = index;
      usedCounts[index]++;
      if (usedCounts[index] > rackCounts[index]!) missingBefore++;
    }
    for (let i = 0; i < touchedCount; i++) {
      usedCounts[touchedIndices[i]!] = 0;
    }
    if (missingBefore === 0 || rackCounts[letterIndex]! >= letterCount) {
      continue;
    }

    const earlyLetterValue = score / Math.sqrt(missingBefore);
    bestLetterValue = Math.max(bestLetterValue, earlyLetterValue);
  }

  const rawBid = Math.floor(
    bestLetterValue * (ctx.isVickrey ? 1 : FIRST_PRICE_VALUE_FRACTION),
  );
  const willingnessToPay =
    ctx.isVickrey && bestLetterValue > 0
      ? Math.max(MIN_USEFUL_VICKREY_BID, rawBid)
      : rawBid;
  const recentBidCount = Math.max(0, ctx.recentBidCount ?? 0);
  const confidence = Math.min(1, recentBidCount / 4);
  const recentWinRate = Math.max(0, Math.min(1, ctx.recentWinRate ?? 0.4));
  const aggression = Math.max(
    0.7,
    Math.min(1.5, 1 + (0.4 - recentWinRate) * confidence),
  );
  const adjustedWillingnessToPay = Math.floor(willingnessToPay * aggression);
  const balanceBidFraction = ctx.isVickrey
    ? VICKREY_MAX_BALANCE_BID_FRACTION
    : FIRST_PRICE_MAX_BALANCE_BID_FRACTION;
  let balanceLimit = Math.floor(balance * balanceBidFraction);
  if (
    ctx.isVickrey &&
    ctx.bagRemaining !== undefined &&
    ctx.playersInMatch !== undefined
  ) {
    const expectedWinsRemaining = Math.max(
      1,
      Math.ceil(
        Math.max(0, ctx.bagRemaining) /
          Math.max(1, ctx.playersInMatch || EXPECTED_MATCH_SIZE),
      ),
    );
    const sustainableBidLimit = Math.ceil(
      (balance / expectedWinsRemaining) *
        MAX_VICKREY_BUDGET_FRACTION *
        aggression,
    );
    balanceLimit = Math.min(balanceLimit, sustainableBidLimit);
  }
  balanceLimit = Math.max(1, balanceLimit);
  const strategicBid = Math.min(adjustedWillingnessToPay, balanceLimit);
  if (!ctx.isVickrey) {
    return Math.min(balance, strategicBid);
  }

  let rivalObservedPayment = 0;
  for (const opponent of ctx.opponents) {
    if (opponent.score * 10 < ctx.myScore * 9) continue;
    const payments = opponent.winningPayments
      .filter((payment) => payment > 0)
      .sort((a, b) => a - b);
    if (payments.length === 0) continue;
    const median = payments[Math.floor((payments.length - 1) / 2)]!;
    rivalObservedPayment = Math.max(rivalObservedPayment, median);
  }
  const defenseCap = Math.min(
    Math.floor(bestLetterValue * DEFENSE_VALUE_FRACTION),
    balanceLimit,
  );
  const defensiveBid = Math.min(
    defenseCap,
    Math.floor(
      rivalObservedPayment * DEFENSE_OBSERVED_PAYMENT_FRACTION * aggression,
    ),
  );
  return Math.min(balance, Math.max(strategicBid, defensiveBid));
}

export function chooseWord(ctx: WordContext): string | null {
  let bestWord: string | null = null;
  let bestScore = 0;
  for (const word of ctx.dictionary) {
    if (!canSpell(word, ctx.myRack)) continue;
    const score = reward(word);
    if (score > bestScore) {
      bestScore = score;
      bestWord = word;
    }
  }

  if (!bestWord || ctx.myBalance === undefined) return bestWord;
  if (ctx.bagRemaining === 0) return bestWord;

  const balance = Math.max(0, ctx.myBalance);
  const holdThreshold = Math.max(
    MIN_BALANCE_TO_HOLD,
    Math.min(MAX_BALANCE_TO_HOLD, Math.ceil(bestScore * WORD_VALUE_FRACTION_TO_PLAY)),
  );
  return balance <= holdThreshold || bestScore >= 35 ? bestWord : null;
}

function canSpell(word: string, rack: Map<string, number>): boolean {
  const used: Record<string, number> = {};
  for (const letter of word) {
    used[letter] = (used[letter] ?? 0) + 1;
    if (used[letter] > (rack.get(letter) ?? 0)) return false;
  }
  return true;
}
